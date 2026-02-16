const mysql = require("mysql2/promise");
require("dotenv").config();
const { randomUUID } = require("crypto");

const {
  DB_HOST = "localhost",
  DB_USER = "root",
  DB_PASSWORD = "123456",
  DB_NAME = "orangeai",
  DB_PORT = 3306,
} = process.env;

let pool;

/**
 * 数据库初始化
 * - 创建数据库（如果不存在）
 * - 创建连接池
 * - 初始化表结构（users / conversations / messages）
 */
const ready = (async () => {
  // 1️⃣ 先连接 MySQL（不指定 database）
  const conn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: Number(DB_PORT),
  });

  // 创建数据库
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
     DEFAULT CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci;`,
  );
  await conn.end();

  // 2️⃣ 创建连接池
  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    port: Number(DB_PORT),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // 3️⃣ 初始化 users 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱',
      username VARCHAR(100) NOT NULL COMMENT '用户名',
      password VARCHAR(255) NOT NULL COMMENT '密码（加密）',
      role ENUM('user','admin') DEFAULT 'user' COMMENT '角色',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      last_login TIMESTAMP NULL DEFAULT NULL COMMENT '最后登录时间',
      login_count INT DEFAULT 0 COMMENT '登录次数'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 4️⃣ 初始化 conversations 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id CHAR(36) PRIMARY KEY COMMENT 'UUID 对话ID',
      user_id INT NOT NULL COMMENT '用户ID，关联 users 表',
      title VARCHAR(255) DEFAULT '新对话' COMMENT '对话标题',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
      CONSTRAINT fk_user_conversation FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 5️⃣ 初始化 messages 表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '消息ID',
      conversation_id CHAR(36) NOT NULL COMMENT '关联对话ID',
      role ENUM('user','assistant') NOT NULL COMMENT '消息角色',
      content TEXT NOT NULL COMMENT '消息内容',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '消息创建时间',
      CONSTRAINT fk_conversation_message FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log(
    `✅ 数据库初始化成功: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
  );
})().catch((err) => {
  console.error("❌ 数据库初始化失败:", err);
  process.exit(1);
});

/**
 * 测试数据库连接池是否可用
 */
async function testDbConnection() {
  await ready;
  try {
    const [rows] = await pool.execute("SELECT VERSION() AS mysql_version");
    console.log(`✅ 数据库连接池可用，MySQL版本: ${rows[0].mysql_version}`);
    return true;
  } catch (err) {
    console.error("❌ 数据库连接池不可用:", err);
    return false;
  }
}

/**
 * 用户相关操作
 */
async function getUserByEmail(email) {
  await ready;
  const [rows] = await pool.execute("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0];
}

async function createUser({ email, username, password }) {
  await ready;
  // 向 users 表插入新用户，返回插入后的整行记录
  const role = arguments[0].role || "user";
  const [result] = await pool.execute(
    "INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)",
    [email, username, password, role],
  );
  const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [
    result.insertId,
  ]);
  return rows[0];
}

// 获取单个用户（按 id）
async function getUserById(id) {
  await ready;
  const [rows] = await pool.execute("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0];
}

// 更新用户最后登录信息（更新时间、次数自增）
async function updateUserLoginInfo(userId) {
  await ready;
  await pool.execute(
    "UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = login_count + 1 WHERE id = ?",
    [userId],
  );
  return true;
}

// 列表查询用户，支持 search（用户名或邮箱模糊）、role、offset、limit
async function getUsers({ search, role, offset = 0, limit = 10 } = {}) {
  await ready;
  const params = [];
  let where = "WHERE 1=1";
  if (search) {
    where += " AND (username LIKE ? OR email LIKE ? )";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += " AND role = ?";
    params.push(role);
  }

  const sql = `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ${Number(
    limit,
  )} OFFSET ${Number(offset)}`;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getUsersCount({ search, role } = {}) {
  await ready;
  const params = [];
  let where = "WHERE 1=1";
  if (search) {
    where += " AND (username LIKE ? OR email LIKE ? )";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += " AND role = ?";
    params.push(role);
  }
  const sql = `SELECT COUNT(1) AS total FROM users ${where}`;
  const [rows] = await pool.execute(sql, params);
  return rows[0] ? rows[0].total : 0;
}

// 更新用户字段（支持 username, email, password, role）
async function updateUser(userId, updates = {}) {
  await ready;
  const allowed = ["username", "email", "password", "role"];
  const sets = [];
  const params = [];
  for (const k of Object.keys(updates)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    params.push(updates[k]);
  }
  if (sets.length === 0) return null;
  params.push(userId);
  const sql = `UPDATE users SET ${sets.join(", ")} WHERE id = ?`;
  await pool.execute(sql, params);
  return getUserById(userId);
}

async function deleteUser(userId) {
  await ready;
  const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [
    userId,
  ]);
  return result.affectedRows > 0;
}

async function deleteUsers(userIds = []) {
  await ready;
  if (!Array.isArray(userIds) || userIds.length === 0) return 0;
  const placeholders = userIds.map(() => "?").join(",");
  const sql = `DELETE FROM users WHERE id IN (${placeholders})`;
  const [result] = await pool.execute(sql, userIds);
  return result.affectedRows || 0;
}

async function getUsersByIds(userIds = []) {
  await ready;
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const sql = `SELECT * FROM users WHERE id IN (${placeholders})`;
  const [rows] = await pool.execute(sql, userIds);
  return rows;
}

async function getUserStats() {
  await ready;
  const [[summary]] = await pool.execute(
    `SELECT COUNT(1) AS total, SUM(role='admin') AS admins, SUM(role='user') AS users FROM users`,
  );
  const [[recent]] = await pool.execute(
    `SELECT COUNT(1) AS new_users_7d FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
  );
  return {
    total: summary.total || 0,
    admins: Number(summary.admins) || 0,
    users: Number(summary.users) || 0,
    new_users_7d: recent.new_users_7d || 0,
  };
}

/**
 * 对话与消息操作
 */
const createConversation = async (userId, title = "新对话") => {
  await ready;
  const conversationId = randomUUID();
  await pool.execute(
    "INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)",
    [conversationId, userId, title],
  );
  return { conversation_id: conversationId, user_id: userId, title };
};

const addMessage = async (conversationId, role, content) => {
  await ready;
  const [result] = await pool.execute(
    "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
    [conversationId, role, content],
  );
  // 更新 conversations.updated_at
  await pool.execute(
    "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?",
    [conversationId],
  );
  return {
    message_id: result.insertId,
    conversation_id: conversationId,
    role,
    content,
  };
};

/**
 * 获取用户对话列表（支持分页）
 */
const listConversations = async (userId, page = 1, pageSize = 20) => {
  await ready;
  const offset = (page - 1) * pageSize;

  const limit = Number(pageSize);
  const off = Number(offset);

  // 一些 MySQL 版本/配置对 LIMIT/OFFSET 使用预处理参数支持不一致，
  // 因此在验证为数字后直接插入到 SQL 中以避免 ER_WRONG_ARGUMENTS 错误。
  const sql = `
    SELECT 
      c.conversation_id, c.title, c.created_at, c.updated_at,
      (SELECT content FROM messages m 
       WHERE m.conversation_id = c.conversation_id 
       ORDER BY m.created_at DESC LIMIT 1) AS last_message
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC
    LIMIT ${limit} OFFSET ${off}
  `;

  const [rows] = await pool.execute(sql, [userId]);

  const [countRows] = await pool.execute(
    "SELECT COUNT(1) AS total FROM conversations WHERE user_id = ?",
    [userId],
  );
  const total = countRows && countRows[0] ? countRows[0].total : 0;

  return { items: rows, total };
};

/**
 * 获取单条对话消息列表
 */
const getMessages = async (conversationId, limit = null) => {
  await ready;
  if (limit) {
    const n = Number(limit);
    if (Number.isNaN(n) || n < 1) {
      const [rows] = await pool.execute(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        [conversationId],
      );
      return rows;
    }
    const sql = `SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ${n}`;
    const [rows] = await pool.execute(sql, [conversationId]);
    return rows;
  }
  const [rows] = await pool.execute(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId],
  );
  return rows;
};

/**
 * 获取会话最近 N 条消息，按时间升序返回（如果未指定 limit 则返回全部）
 */
const getConversationMessages = async (conversationId, limit = null) => {
  await ready;
  if (limit) {
    // 先按时间倒序取最近 N 条，再在内存中反转为升序，保证返回时为时间顺序（老 -> 新）
    const n = Number(limit);
    if (Number.isNaN(n) || n < 1) {
      const [rows] = await pool.execute(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        [conversationId],
      );
      return rows;
    }
    const sql = `SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ${n}`;
    const [rows] = await pool.execute(sql, [conversationId]);
    return rows.reverse();
  }
  const [rows] = await pool.execute(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId],
  );
  return rows;
};

/**
 * 删除用户的某条对话（级联删除消息）
 */
const deleteConversation = async (conversationId, userId) => {
  await ready;
  const [result] = await pool.execute(
    "DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId],
  );
  return result.affectedRows > 0;
};

// 启动时测试数据库连接
testDbConnection();

const userMethods = {
  getUserByEmail,
  createUser,
  getUserById,
  updateUserLoginInfo,
  getUsers,
  getUsersCount,
  updateUser,
  deleteUser,
  deleteUsers,
  getUsersByIds,
  getUserStats,
};

const conversationMethods = {
  createConversation,
  addMessage,
  listConversations,
  getMessages,
  deleteConversation,
  getConversationMessages,
};

module.exports = {
  // 兼容原有扁平导出
  ...userMethods,
  ...conversationMethods,
  testDbConnection,
  _pool: () => pool,
  // 新增命名空间导出，便于按功能分组引用
  user: userMethods,
  conversation: conversationMethods,
};
