const { getPool, ready } = require("../db/pool");

async function getUserByEmail(email) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0] || null;
}

async function getUserById(id) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] || null;
}

async function createUser({ email, username, password, role = "user" }) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)",
    [email, username, password, role],
  );
  return getUserById(result.insertId);
}

async function updateUserLoginInfo(userId) {
  await ready;
  const pool = await getPool();
  await pool.execute(
    "UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?",
    [userId],
  );
  return true;
}

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
  await pool.execute(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  return getUserById(userId);
}

async function deleteUser(userId) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [
    userId,
  ]);
  return result.affectedRows > 0;
}

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
