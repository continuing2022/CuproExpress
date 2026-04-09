const { getPool, ready } = require("../db/pool");
// tokenRepo.js - 处理令牌相关的数据库操作
// 刷新令牌数据访问对象
async function saveRefreshToken({ userId, token, expiresAt }) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
    [userId, token, expiresAt],
  );
  return result.insertId;
}
// 根据令牌获取刷新令牌信息
async function getRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM refresh_tokens WHERE token = ? LIMIT 1",
    [token],
  );
  return rows[0] || null;
}
// 撤销刷新令牌
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
