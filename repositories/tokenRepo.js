const { createHash } = require("crypto");
const { getPool, ready } = require("../db/pool");

function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

async function saveRefreshToken({ userId, token, expiresAt }) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [result] = await pool.execute(
    "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt],
  );
  return result.insertId;
}

async function getRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [rows] = await pool.execute(
    "SELECT * FROM refresh_tokens WHERE token IN (?, ?) LIMIT 1",
    [tokenHash, token],
  );
  return rows[0] || null;
}

async function revokeRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [result] = await pool.execute(
    "UPDATE refresh_tokens SET revoked = TRUE WHERE token IN (?, ?)",
    [tokenHash, token],
  );
  return result.affectedRows > 0;
}

async function revokeRefreshTokensByUserId(userId) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?",
    [userId],
  );
  return result.affectedRows || 0;
}

module.exports = {
  saveRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokensByUserId,
};
