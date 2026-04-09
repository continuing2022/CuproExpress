const { getPool, ready } = require("../db/pool");
// userRepo.js - 处理用户相关的数据库操作
// 获取用户通过邮箱
async function getUserByEmail(email) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0] || null;
}
// 获取用户通过ID
async function getUserById(id) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] || null;
}
// 创建新用户
async function createUser({ email, username, password, role = "user" }) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)",
    [email, username, password, role],
  );
  return getUserById(result.insertId);
}
// 更新用户登录信息（最后登录时间和登录次数）
async function updateUserLoginInfo(userId) {
  await ready;
  const pool = await getPool();
  await pool.execute(
    "UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?",
    [userId],
  );
  return true;
}
// 获取用户列表，支持搜索和分页
async function getUsers({ search, role, offset = 0, limit = 10 } = {}) {
  await ready;
  const pool = await getPool();
  const params = [];
  let where = "WHERE 1=1";

  if (search) {
    where += " AND (username LIKE ? OR email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += " AND role = ?";
    params.push(role);
  }

  const safeLimit = Math.max(1, Number(limit) || 10);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const sql = `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}
// 获取用户总数，支持搜索和角色过滤
async function getUsersCount({ search, role } = {}) {
  await ready;
  const pool = await getPool();
  const params = [];
  let where = "WHERE 1=1";

  if (search) {
    where += " AND (username LIKE ? OR email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += " AND role = ?";
    params.push(role);
  }

  const [rows] = await pool.execute(
    `SELECT COUNT(1) AS total FROM users ${where}`,
    params,
  );
  return rows[0]?.total || 0;
}
// 更新用户信息，允许更新用户名、邮箱、密码和角色
async function updateUser(userId, updates = {}) {
  await ready;
  const pool = await getPool();
  const allowed = ["username", "email", "password", "role"];
  const sets = [];
  const params = [];

  for (const key of Object.keys(updates)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = ?`);
    params.push(updates[key]);
  }

  if (sets.length === 0) return null;

  params.push(userId);
  await pool.execute(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
  return getUserById(userId);
}
// 删除用户
async function deleteUser(userId) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [
    userId,
  ]);
  return result.affectedRows > 0;
}
// 批量删除用户
async function deleteUsers(userIds = []) {
  await ready;
  if (!Array.isArray(userIds) || userIds.length === 0) return 0;
  const pool = await getPool();
  const placeholders = userIds.map(() => "?").join(",");
  const [result] = await pool.execute(
    `DELETE FROM users WHERE id IN (${placeholders})`,
    userIds,
  );
  return result.affectedRows || 0;
}
// 根据多个用户ID获取用户信息列表
async function getUsersByIds(userIds = []) {
  await ready;
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const pool = await getPool();
  const placeholders = userIds.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `SELECT * FROM users WHERE id IN (${placeholders})`,
    userIds,
  );
  return rows;
}
// 获取用户统计数据，包括总用户数、管理员数、普通用户数和最近7天新增用户数
async function getUserStats() {
  await ready;
  const pool = await getPool();
  const [[summary]] = await pool.execute(
    "SELECT COUNT(1) AS total, SUM(role='admin') AS admins, SUM(role='user') AS users FROM users",
  );
  const [[recent]] = await pool.execute(
    "SELECT COUNT(1) AS new_users_7d FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
  );

  return {
    total: summary.total || 0,
    admins: Number(summary.admins) || 0,
    users: Number(summary.users) || 0,
    new_users_7d: recent.new_users_7d || 0,
  };
}

module.exports = {
  getUserByEmail,
  getUserById,
  createUser,
  updateUserLoginInfo,
  getUsers,
  getUsersCount,
  updateUser,
  deleteUser,
  deleteUsers,
  getUsersByIds,
  getUserStats,
};
