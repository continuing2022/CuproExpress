// Optional integration check: uses configured LOCAL MySQL credentials, creates
// a unique test database and drops only that database in finally.
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
require("dotenv").config();
const mysql = require("mysql2/promise");
const host = process.env.DB_HOST || "localhost";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  throw new Error("Integration checks require a local MySQL instance");
}
const database = `cupro_auth_test_${randomBytes(8).toString("hex")}`;
process.env.DB_NAME = database;
let admin, pool;
(async () => {
  try {
    admin = await mysql.createConnection({ host, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 });
    pool = await require("../db/pool").getPool();
    const repo = require("../repositories/passwordResetRepo");
    const [insert] = await pool.execute("INSERT INTO users (email, username, password) VALUES (?, ?, ?)", ["reset@example.com", "reset-test", "old-hash"]);
    const userId = insert.insertId;
    await pool.execute("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))", [userId, "old-refresh"]);
    const token = randomBytes(32).toString("hex");
    assert.equal(await repo.create({ userId, email: "reset@example.com", token, expiresAt: new Date(Date.now() + 60000) }), true);
    assert.equal(await repo.create({ userId, email: "reset@example.com", token: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60000) }), false);
    const results = await Promise.all([repo.consume(token, "new-hash-a"), repo.consume(token, "new-hash-b")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await repo.consume(token, "replayed"), false);
    const [[user]] = await pool.execute("SELECT password, session_version FROM users WHERE id = ?", [userId]);
    assert.equal(user.password, results[0] ? "new-hash-a" : "new-hash-b");
    assert.equal(user.session_version, 1);
    const [[refresh]] = await pool.execute("SELECT revoked FROM refresh_tokens WHERE user_id = ?", [userId]);
    assert.equal(refresh.revoked, 1);
    await pool.execute("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    const expired = randomBytes(32).toString("hex");
    await repo.create({ userId, email: "reset@example.com", token: expired, expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await repo.consume(expired, "expired"), false);
    await pool.execute("UPDATE password_resets SET expires_at = DATE_ADD(NOW(), INTERVAL 1 DAY)");
    await require("../repositories/userRepo").updateUser(userId, { email: "changed@example.com" });
    assert.equal(await repo.consume(expired, "old-email"), false);
    console.log("MySQL reset integration passed: schema, cooldown, concurrent consumption, replay, expiry, revocation and email change.");
  } finally {
    await pool?.end();
    if (admin) {
      assert.match(database, /^cupro_auth_test_[a-f0-9]{16}$/);
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  }
})().catch(error => { console.error("MySQL reset integration failed:", error.code || error.message); process.exitCode = 1; });
