const mysql = require("mysql2/promise");
require("dotenv").config();
const { requireEnv, getEnv } = require("../utils/env");

let pool;
let initPromise;

function readDbConfig() {
  return {
    host: getEnv("DB_HOST", "localhost"),
    user: requireEnv("DB_USER"),
    password: requireEnv("DB_PASSWORD"),
    database: requireEnv("DB_NAME"),
    port: Number(getEnv("DB_PORT", "3306")),
  };
}

async function ensureDatabase(config) {
  const conn = await mysql.createConnection({
    host: config.host,
    user: config.user,
    password: config.password,
    port: config.port,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\`
     DEFAULT CHARACTER SET utf8mb4
     COLLATE utf8mb4_unicode_ci;`,
  );
  await conn.end();
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      username VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('user','admin') DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL DEFAULT NULL,
      login_count INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id CHAR(36) PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(255) DEFAULT 'New Conversation',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_user_conversation
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      conversation_id CHAR(36) NOT NULL,
      role ENUM('user','assistant') NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_conversation_message
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_states (
      conversation_id CHAR(36) PRIMARY KEY,
      running_summary LONGTEXT NULL,
      summary_version INT NOT NULL DEFAULT 0,
      last_summarized_message_id BIGINT NOT NULL DEFAULT 0,
      last_summary_at TIMESTAMP NULL DEFAULT NULL,
      memory_facts_json JSON NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_conversation_state
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      token VARCHAR(500) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_token (token),
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function initializePool() {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = readDbConfig();
    await ensureDatabase(config);

    pool = mysql.createPool({
      host: config.host,
      user: config.user,
      password: config.password,
      database: config.database,
      port: config.port,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await ensureTables();
    return pool;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

const ready = {
  then(onFulfilled, onRejected) {
    return initializePool().then(onFulfilled, onRejected);
  },
  catch(onRejected) {
    return initializePool().catch(onRejected);
  },
  finally(onFinally) {
    return initializePool().finally(onFinally);
  },
};

async function getPool() {
  return initializePool();
}

async function testDbConnection() {
  const currentPool = await getPool();
  const [rows] = await currentPool.execute("SELECT VERSION() AS mysql_version");
  return rows[0];
}

module.exports = {
  initializePool,
  ready,
  getPool,
  testDbConnection,
};

