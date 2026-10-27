const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
require("dotenv").config();
process.env.JWT_SECRET = "isolated-refresh-access";
process.env.REFRESH_SECRET = "isolated-refresh-secret";
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const host = process.env.DB_HOST || "localhost";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Local MySQL required");
const database = `cupro_refresh_test_${randomBytes(8).toString("hex")}`;
process.env.DB_NAME = database;
let admin, pool, server, base;

(async () => {
  try {
    admin = await mysql.createConnection({ host, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 });
    // Start from the old schema to exercise additive migrations on existing rows.
    await admin.query(`CREATE DATABASE \`${database}\``);
    await admin.query(`CREATE TABLE \`${database}\`.users (
      id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(255) UNIQUE, username VARCHAR(100), password VARCHAR(255),
      role ENUM('user','admin') DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL, login_count INT DEFAULT 0) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE \`${database}\`.refresh_tokens (
      id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, token VARCHAR(500) NOT NULL, expires_at DATETIME NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, INDEX idx_token(token)) ENGINE=InnoDB`);
    pool = await require("../db/pool").getPool();
    const userRepo = require("../repositories/userRepo");
    const tokenRepo = require("../repositories/tokenRepo");
    const auth = require("../utils/auth");
    const { REFRESH_TOKEN_COOKIE_NAME: cookieName } = require("../utils/refreshTokenCookie");
    const app = require("express")();
    app.use(require("express").json());
    app.use("/auth", require("../routes/auth"));
    app.get("/private", auth.authMiddleware, (req, res) => res.json(req.user));
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, body, cookie, access, method = "POST") => fetch(base + path, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookieOf = response => response.headers.get("set-cookie").split(";")[0];
    const login = async (email, password = "old-password", rememberMe = false) => {
      const response = await request("/auth/login", { email, password, rememberMe });
      assert.equal(response.status, 200);
      return { response, cookie: cookieOf(response), access: (await response.json()).token.accessToken };
    };
    const user = await userRepo.createUser({ email: "refresh@example.com", username: "refresh-test", password: await bcrypt.hash("old-password", 4), role: "admin" });
    const first = await login(user.email);
    const legacyAccess = require("jsonwebtoken").sign({ id: user.id, role: "admin", iat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET, { expiresIn: "8h" });
    assert.equal((await request("/private", undefined, null, legacyAccess, "GET")).status, 401, "legacy 8-hour access is capped at 15 minutes");
    assert.ok(!/Max-Age|Expires/i.test(first.response.headers.get("set-cookie")));
    const parallel = await Promise.all([request("/auth/refresh", {}, first.cookie), request("/auth/refresh", {}, first.cookie)]);
    assert.deepEqual(parallel.map(response => response.status).sort(), [200, 409]);
    const winner = parallel.find(response => response.status === 200);
    const loser = parallel.find(response => response.status === 409);
    assert.equal(loser.headers.get("set-cookie"), null);
    assert.equal((await loser.json()).code, "refresh_conflict");
    const nextCookie = cookieOf(winner);
    assert.notEqual(nextCookie, first.cookie);
    assert.ok(!/Max-Age|Expires/i.test(winner.headers.get("set-cookie")));
    const nextAccess = (await winner.json()).accessToken;
    let [[counts]] = await pool.execute("SELECT SUM(NOT revoked) AS live FROM refresh_tokens WHERE user_id = ?", [user.id]);
    assert.equal(Number(counts.live), 1);

    // Database failure rolls back old-token consumption and does not clear cookies.
    const originalRotate = tokenRepo.rotateRefreshToken;
    tokenRepo.rotateRefreshToken = () => { throw new Error("database unavailable"); };
    try {
      const unavailable = await request("/auth/refresh", {}, nextCookie);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get("set-cookie"), null);
    } finally { tokenRepo.rotateRefreshToken = originalRotate; }
    const nextToken = nextCookie.slice(cookieName.length + 1);
    await assert.rejects(tokenRepo.rotateRefreshToken({
      token: nextToken, payload: auth.verifyRefreshToken(nextToken),
      issueTokens: current => ({ refreshToken: auth.signRefreshToken(current), accessToken: auth.signAccessToken(current), expiresAt: null }),
    }));
    [[counts]] = await pool.execute("SELECT SUM(NOT revoked) AS live FROM refresh_tokens WHERE user_id = ?", [user.id]);
    assert.equal(Number(counts.live), 1, "failed insertion rolls back revocation");
    assert.equal((await request("/auth/refresh", {}, nextCookie)).status, 200);

    // A replay outside the race window invalidates access AND all refresh tokens.
    await pool.execute("UPDATE refresh_tokens SET rotated_at = DATE_SUB(NOW(3), INTERVAL 10 SECOND) WHERE user_id = ? AND revoked = TRUE", [user.id]);
    assert.equal((await request("/auth/refresh", {}, first.cookie)).status, 401);
    assert.equal((await request("/private", undefined, null, nextAccess, "GET")).status, 401);
    [[counts]] = await pool.execute("SELECT SUM(NOT revoked) AS live FROM refresh_tokens WHERE user_id = ?", [user.id]);
    assert.equal(Number(counts.live), 0);

    const beforeChange = await login(user.email, "old-password", true);
    assert.match(beforeChange.response.headers.get("set-cookie"), /Max-Age=/);
    const persistentRefresh = await request("/auth/refresh", {}, beforeChange.cookie);
    assert.equal(persistentRefresh.status, 200);
    assert.match(persistentRefresh.headers.get("set-cookie"), /Max-Age=/);
    const changed = await request(`/auth/users/${user.id}/password`, { newPassword: "new-password" }, null, beforeChange.access, "PUT");
    assert.equal(changed.status, 200);
    assert.equal((await request("/private", undefined, null, beforeChange.access, "GET")).status, 401);
    assert.equal((await request("/auth/refresh", {}, cookieOf(persistentRefresh))).status, 401);
    const afterChange = await login(user.email, "new-password");
    const demote = await request(`/auth/users/${user.id}`, { role: "user" }, null, afterChange.access, "PUT");
    assert.equal(demote.status, 200);
    assert.equal((await request("/auth/users", undefined, null, afterChange.access, "GET")).status, 401);
    const member = await login(user.email, "new-password");
    assert.equal((await request("/auth/users", undefined, null, member.access, "GET")).status, 403);
    const malformed = await request("/auth/refresh", {}, `unrelated=%E0%A4%A; ${member.cookie}`);
    assert.equal(malformed.status, 200);
    assert.equal((await request("/auth/refresh", {}, `${cookieName}=%E0%A4%A`)).status, 401);
    assert.equal((await request("/auth/logout", {}, `${cookieName}=%E0%A4%A`)).status, 200);
    await userRepo.deleteUser(user.id);
    assert.equal((await request("/private", undefined, null, member.access, "GET")).status, 401);
    assert.equal((await request("/auth/refresh", {}, cookieOf(malformed))).status, 401);

    // Legacy raw tokens without sv/jti, including historical duplicate rows.
    const legacyUser = await userRepo.createUser({ email: "legacy@example.com", username: "legacy-test", password: "unused" });
    const legacyToken = require("jsonwebtoken").sign({ id: legacyUser.id }, process.env.REFRESH_SECRET, { expiresIn: "7d" });
    for (let i = 0; i < 2; i++) await pool.execute("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", [legacyUser.id, legacyToken]);
    assert.equal((await request("/auth/refresh", {}, `${cookieName}=${legacyToken}`)).status, 200);
    [[counts]] = await pool.execute("SELECT SUM(NOT revoked) AS live FROM refresh_tokens WHERE user_id = ?", [legacyUser.id]);
    assert.equal(Number(counts.live), 1);
    const raceUser = await userRepo.createUser({ email: "race@example.com", username: "race-test", password: "unused" });
    const raceRefresh = auth.signRefreshToken(raceUser);
    await tokenRepo.saveRefreshToken({ userId: raceUser.id, token: raceRefresh, expiresAt: new Date(Date.now() + 60000) });
    const resetRepo = require("../repositories/passwordResetRepo");
    const resetToken = randomBytes(32).toString("hex");
    await resetRepo.create({ userId: raceUser.id, email: raceUser.email, token: resetToken, expiresAt: new Date(Date.now() + 60000) });
    const [raced, reset] = await Promise.all([
      tokenRepo.rotateRefreshToken({ token: raceRefresh, payload: auth.verifyRefreshToken(raceRefresh), issueTokens: current => ({ accessToken: auth.signAccessToken(current), refreshToken: auth.signRefreshToken(current), expiresAt: new Date(Date.now() + 60000) }) }),
      resetRepo.consume(resetToken, "reset-hash"),
    ]);
    assert.equal(reset, true);
    assert.ok(["ok", "invalid"].includes(raced.status));
    if (raced.status === "ok") assert.equal((await request("/private", undefined, null, raced.accessToken, "GET")).status, 401);
    [[counts]] = await pool.execute("SELECT SUM(NOT revoked) AS live FROM refresh_tokens WHERE user_id = ?", [raceUser.id]);
    assert.equal(Number(counts.live), 0, "a refresh racing reset cannot escape revocation");

    console.log("MySQL auth integration passed: migration, atomic/concurrent rotation, replay, rollback, session cookies, password/role/deletion revocation, malformed cookies and legacy tokens.");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool?.end();
    if (admin) {
      assert.match(database, /^cupro_refresh_test_[a-f0-9]{16}$/);
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  }
})().catch(error => { console.error("MySQL auth integration failed:", error.code || error.message); process.exitCode = 1; });
