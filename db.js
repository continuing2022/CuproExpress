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
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE COMMENT '邮箱',
      username VARCHAR(255) NOT NULL UNIQUE COMMENT '用户名',
      password VARCHAR(255) NOT NULL COMMENT '密码（加密）'
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

async function getUserByUsername(username) {
  await ready;
  const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  return rows[0];
}

async function createUser({ email, username, password }) {
  await ready;
  const [result] = await pool.execute(
    "INSERT INTO users (email, username, password) VALUES (?, ?, ?)",
    [email, username, password],
  );
  return {
    id: result.insertId,
    email,
    username,
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
    const [rows] = await pool.execute(
      "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
      [conversationId, Number(limit)],
    );
    return rows;
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
  getUserByUsername,
  createUser,
};

const conversationMethods = {
  createConversation,
  addMessage,
  listConversations,
  getMessages,
  deleteConversation,
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
