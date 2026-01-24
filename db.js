const mysql = require("mysql2/promise");
require("dotenv").config();

const {
  DB_HOST = "localhost",
  DB_USER = "root",
  DB_PASSWORD = "123456",
  DB_NAME = "orangeai",
  DB_PORT = 3306,
} = process.env;

let pool;

const ready = (async () => {
  const conn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: Number(DB_PORT),
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await conn.end();

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

  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  );
  console.log(
    `✅ 数据库初始化成功: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
  );
})().catch((err) => {
  console.error("❌ 数据库初始化失败:", err);
  process.exit(1); // 连接失败直接退出项目，防止后续代码报错
});

// ===================== 新增：手动测试连接的核心方法 =====================
async function testDbConnection() {
  await ready; // 等待初始化完成
  try {
    // 执行一个最简单的SQL查询（查询MySQL版本，无副作用，最适合测试）
    const [rows] = await pool.execute("SELECT VERSION() as mysql_version");
    console.log(`✅ 数据库连接池可用，MySQL版本: ${rows[0].mysql_version}`);
    return true;
  } catch (err) {
    console.error("❌ 数据库连接池不可用，连接失败:", err);
    return false;
  }
}

// ===================== 原有业务方法 =====================
async function getUserByUsername(username) {
  await ready;
  const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  return rows[0];
}

async function createUser(username, hashedPassword) {
  await ready;
  const [result] = await pool.execute(
    "INSERT INTO users (username, password) VALUES (?, ?)",
    [username, hashedPassword]
  );
  return { id: result.insertId, username };
}

// 项目启动时，自动执行测试连接
testDbConnection();

module.exports = {
  getUserByUsername,
  createUser,
  _pool: () => pool,
  testDbConnection, // 导出测试方法，供其他模块调用
};
