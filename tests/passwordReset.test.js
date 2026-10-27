const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
process.env.JWT_SECRET = "reset-test-access";
process.env.REFRESH_SECRET = "reset-test-refresh";
process.env.NODE_ENV = "test";
process.env.MAIL_TRANSPORT = "json";
process.env.ALLOW_INSECURE_PASSWORD_RESET = "1";

// Execute repository SQL against a transactional boundary double. No real users,
// SMTP servers or application databases are touched by this test suite.
let state;
let tail = Promise.resolve();
let failRevocation = false;
let locked = false;
const poolModule = require("../db/pool");
poolModule.getPool = async () => ({
  async getConnection() {
    let unlock, snapshot;
    return {
      async beginTransaction() {
        const previous = tail;
        tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        snapshot = structuredClone(state);
        locked = false;
      },
      async execute(sql, values) {
        if (sql.startsWith("SELECT") && sql.includes("FROM users")) {
          assert.match(sql, /FOR UPDATE$/);
          locked = true;
          return [[state.user].filter(user => user && user.id === values[0])];
        }
        if (sql.startsWith("SELECT user_id")) {
          return [[state.resets.get(values[0])].filter(Boolean)];
        }
        assert.ok(locked, `User must be locked before ${sql}`);
        if (sql.startsWith("SELECT token_hash")) {
          return [[...state.resets.values()].filter(row => row.user_id === values[0] && row.created_at > Date.now() - 60000)];
        }
        if (sql.startsWith("DELETE FROM password_resets")) {
          for (const [hash, row] of state.resets) if (row.user_id === values[0]) state.resets.delete(hash);
          return [{}];
        }
        if (sql.startsWith("INSERT INTO password_resets")) {
          const [token_hash, user_id, session_version, expires_at] = values;
          state.resets.set(token_hash, { token_hash, user_id, session_version, expires_at, created_at: Date.now(), consumed_at: null });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("UPDATE password_resets SET consumed_at = NOW")) {
          const row = state.resets.get(values[0]);
          const valid = row && !row.consumed_at && row.expires_at > new Date();
          if (valid) row.consumed_at = Date.now();
          return [{ affectedRows: valid ? 1 : 0 }];
        }
        if (sql.startsWith("UPDATE users")) {
          state.user.password = values[0];
          state.user.session_version++;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("UPDATE refresh_tokens")) {
          if (failRevocation) throw new Error("simulated revocation failure");
          state.revoked = true;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith("UPDATE password_resets SET consumed_at = COALESCE")) {
          for (const row of state.resets.values()) row.consumed_at ||= Date.now();
          return [{}];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      async commit() {},
      async rollback() { state = snapshot; },
      release() { unlock(); },
    };
  },
  async execute(sql, values) {
    assert.match(sql, /^DELETE FROM password_resets WHERE token_hash = \?$/);
    state.resets.delete(values[0]);
    return [{}];
  },
});
const resetRepo = require("../repositories/passwordResetRepo");
const userRepo = require("../repositories/userRepo");
userRepo.getUserByEmail = async email => state.user?.email === email ? { ...state.user } : null;
userRepo.getUserById = async id => state.user?.id === id ? { ...state.user } : null;
const mail = require("../services/passwordResetMail");
const actualSend = mail.send;
let delivered = [], deliveryFailure = false;
mail.send = async message => {
  if (deliveryFailure) throw new Error("SMTP failure");
  delivered.push(message);
};
const auth = require("../utils/auth");
const { REFRESH_TOKEN_COOKIE_NAME } = require("../utils/refreshTokenCookie");
let server, base;
before(async () => {
  const app = require("express")();
  app.use(require("express").json());
  app.use("/auth", require("../routes/auth"));
  app.get("/private", auth.authMiddleware, (req, res) => res.json(req.user));
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise(resolve => server.close(resolve)));

async function fresh() {
  state = { user: { id: 1, email: "user@example.com", role: "user", password: await bcrypt.hash("old-password", 4), session_version: 0 }, resets: new Map(), revoked: false };
  delivered = [];
  failRevocation = deliveryFailure = false;
}
function post(path, body, headers = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function issue() {
  const response = await post("/auth/forgot-password", { email: state.user.email, password: "attacker-password" });
  assert.equal(response.status, 202);
  return delivered.at(-1)?.token;
}

test("request does not reset passwords or expose account existence; tokens are random and hashed", async () => {
  await fresh();
  const oldHash = state.user.password;
  const existing = await post("/auth/forgot-password", { email: " USER@example.com ", password: "attacker-password" });
  const unknown = await post("/auth/forgot-password", { email: "missing@example.com" });
  assert.equal(existing.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await existing.json(), await unknown.json());
  const token = delivered[0].token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(state.user.password, oldHash);
  assert.ok(state.resets.has(resetRepo.hashToken(token)));
  assert.ok(!JSON.stringify([...state.resets.values()]).includes(token));
  await issue();
  assert.equal(delivered.length, 1, "cooldown suppresses repeated email delivery");
});

test("one concurrent reset succeeds; old access/refresh credentials are rejected", async () => {
  await fresh();
  const access = auth.signAccessToken(state.user);
  const refresh = auth.signRefreshToken(state.user);
  assert.equal((await fetch(base + "/private", { headers: { Authorization: `Bearer ${access}` } })).status, 200);
  const token = await issue();
  const responses = await Promise.all(["new-password-a", "new-password-b"].map(password => post("/auth/reset-password", { token, password })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  const winner = responses[0].status === 200 ? "new-password-a" : "new-password-b";
  assert.ok(await bcrypt.compare(winner, state.user.password));
  assert.equal(state.user.session_version, 1);
  assert.ok(state.revoked);
  assert.equal((await fetch(base + "/private", { headers: { Authorization: `Bearer ${access}` } })).status, 401);
  const tokenRepo = require("../repositories/tokenRepo");
  tokenRepo.rotateRefreshToken = async ({ payload }) => {
    assert.notEqual(payload.sv, state.user.session_version);
    return { status: "invalid" };
  };
  assert.equal((await post("/auth/refresh", {}, { Cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${refresh}` })).status, 401);
  const next = auth.signAccessToken(state.user);
  assert.equal((await fetch(base + "/private", { headers: { Authorization: `Bearer ${next}` } })).status, 200);
  const adminClaim = require("jsonwebtoken").sign({ id: state.user.id, role: "admin", sv: 1 }, process.env.JWT_SECRET);
  const currentRole = await fetch(base + "/private", { headers: { Authorization: `Bearer ${adminClaim}` } });
  assert.equal((await currentRole.json()).role, "user", "authorization uses current database role");
  state.user = null;
  assert.equal((await fetch(base + "/private", { headers: { Authorization: `Bearer ${next}` } })).status, 401);
});

test("expired, missing, consumed and pre-account-change tokens cannot change passwords", async () => {
  await fresh();
  const token = await issue();
  const row = state.resets.get(resetRepo.hashToken(token));
  row.expires_at = new Date(Date.now() - 1);
  assert.equal((await post("/auth/reset-password", { token, password: "new-password" })).status, 400);
  row.expires_at = new Date(Date.now() + 100000);
  state.user.session_version++;
  assert.equal((await post("/auth/reset-password", { token, password: "new-password" })).status, 400);
  assert.equal((await post("/auth/reset-password", { email: state.user.email, password: "new-password" })).status, 400);
  assert.equal((await post("/auth/reset-password", { token: randomBytes(32).toString("hex"), password: "new-password" })).status, 400);
  assert.ok(await bcrypt.compare("old-password", state.user.password));
});

test("transaction rolls back password and consumption if session revocation fails", async () => {
  await fresh();
  const token = await issue();
  failRevocation = true;
  await assert.rejects(resetRepo.consume(token, "not-committed"), /revocation failure/);
  assert.equal(state.user.session_version, 0);
  assert.equal(state.resets.get(resetRepo.hashToken(token)).consumed_at, null);
  failRevocation = false;
  assert.equal(await resetRepo.consume(token, "committed"), true);
});

test("mail failure removes credential; malformed refresh cookie is handled", async () => {
  await fresh();
  deliveryFailure = true;
  assert.equal((await post("/auth/forgot-password", { email: state.user.email })).status, 202);
  assert.equal(state.resets.size, 0);
  assert.equal((await post("/auth/refresh", {}, { Cookie: `${REFRESH_TOKEN_COOKIE_NAME}=%E0%A4%A` })).status, 401);
});

test("mail configuration fails closed in production and mock transport generates a usable link", async () => {
  await fresh();
  process.env.NODE_ENV = "production";
  assert.throws(() => mail.configuration(), /transport/);
  assert.equal((await post("/auth/forgot-password", { email: state.user.email })).status, 503);
  assert.equal((await post("/auth/forgot-password", { email: "missing@example.com" })).status, 503);
  process.env.MAIL_TRANSPORT = "smtp";
  process.env.PASSWORD_RESET_URL = "http://example.com/login";
  assert.throws(() => mail.configuration(), /URL/);
  process.env.NODE_ENV = "test";
  process.env.MAIL_TRANSPORT = "json";
  process.env.PASSWORD_RESET_URL = "http://localhost:5173/login";
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const directory = path.join(__dirname, "../.local-mail");
  const previous = new Set(await fs.readdir(directory).catch(() => []));
  const token = randomBytes(32).toString("hex");
  await actualSend({ email: state.user.email, token });
  const generated = (await fs.readdir(directory)).filter(name => !previous.has(name));
  assert.equal(generated.length, 1);
  try {
    const message = JSON.parse(await fs.readFile(path.join(directory, generated[0]), "utf8"));
    assert.match(message.text, new RegExp(`/login#reset-token=${token}`));
  } finally {
    await fs.unlink(path.join(directory, generated[0]));
  }
});
