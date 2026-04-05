const { getPool, ready } = require("../db/pool");

async function saveRefreshToken({ userId, token, expiresAt }) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
    [userId, token, expiresAt],
  );
  return result.insertId;
}

async function getRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM refresh_tokens WHERE token = ? LIMIT 1",
    [token],
  );
  return rows[0] || null;
}

async function revokeRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "UPDATE refresh_tokens SET revoked = TRUE WHERE token = ?",
    [token],
  );
  return result.affectedRows > 0;
}

module.exports = {
  saveRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
};
