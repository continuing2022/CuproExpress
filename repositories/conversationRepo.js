const { randomUUID } = require("crypto");
const { getPool, ready } = require("../db/pool");
// conversationRepo.js - 处理对话相关的数据库操作
// 创建新对话
async function createConversation(userId, title = "新对话") {
  await ready;
  const pool = await getPool();
  const conversationId = randomUUID();
  await pool.execute(
    "INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)",
    [conversationId, userId, title],
  );
  return { conversation_id: conversationId, user_id: userId, title };
}
// 根据对话ID获取对话信息
async function getConversationById(conversationId) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM conversations WHERE conversation_id = ?",
    [conversationId],
  );
  return rows[0] || null;
}
// 验证用户是否是对话的所有者
async function assertConversationOwner(userId, conversationId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) {
    return { ok: false, status: 404, error: "conversation not found" };
  }
  if (conversation.user_id !== userId) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, conversation };
}
// 添加消息到对话中
async function addMessage(conversationId, role, content) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
    [conversationId, role, content],
  );
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
}
// 列出用户的对话列表，支持分页
async function listConversations(userId, page = 1, pageSize = 20) {
  await ready;
  const pool = await getPool();
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (safePage - 1) * safePageSize;

  const sql = `
    SELECT
      c.conversation_id, c.title, c.created_at, c.updated_at,
      (
        SELECT content
        FROM messages m
        WHERE m.conversation_id = c.conversation_id
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 1
      ) AS last_message
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC
    LIMIT ${safePageSize} OFFSET ${offset}
  `;

  const [rows] = await pool.execute(sql, [userId]);
  const [countRows] = await pool.execute(
    "SELECT COUNT(1) AS total FROM conversations WHERE user_id = ?",
    [userId],
  );

  return {
    items: rows,
    total: countRows[0]?.total || 0,
  };
}
// 获取对话中的消息列表，支持限制返回最近的N条消息
async function getMessages(conversationId, limit = null) {
  await ready;
  const pool = await getPool();

  if (!limit) {
    const [rows] = await pool.execute(
      "SELECT message_id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, message_id ASC",
      [conversationId],
    );
    return rows;
  }

  const safeLimit = Number(limit);
  if (Number.isNaN(safeLimit) || safeLimit < 1) {
    return getMessages(conversationId, null);
  }

  const [rows] = await pool.execute(
    `SELECT message_id, role, content, created_at
     FROM (
       SELECT message_id, role, content, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, message_id DESC
       LIMIT ${safeLimit}
     ) recent
     ORDER BY created_at ASC, message_id ASC`,
    [conversationId],
  );
  return rows;
}

async function getMessagesAfter(conversationId, afterMessageId = 0, options = {}) {
  await ready;
  const pool = await getPool();
  const params = [conversationId, Number(afterMessageId) || 0];
  const where = ["conversation_id = ?", "message_id > ?"];

  if (Number.isFinite(options.beforeMessageId)) {
    where.push("message_id < ?");
    params.push(Number(options.beforeMessageId));
  }

  const limit = Number(options.limit);
  const limitSql =
    Number.isFinite(limit) && limit > 0
      ? ` LIMIT ${Math.min(500, Math.floor(limit))}`
      : "";

  const [rows] = await pool.execute(
    `SELECT message_id, role, content, created_at
       FROM messages
      WHERE ${where.join(" AND ")}
      ORDER BY created_at ASC, message_id ASC${limitSql}`,
    params,
  );

  return rows;
}

async function countMessagesAfter(conversationId, afterMessageId = 0, options = {}) {
  await ready;
  const pool = await getPool();
  const params = [conversationId, Number(afterMessageId) || 0];
  const where = ["conversation_id = ?", "message_id > ?"];

  if (Number.isFinite(options.beforeMessageId)) {
    where.push("message_id < ?");
    params.push(Number(options.beforeMessageId));
  }

  const [rows] = await pool.execute(
    `SELECT COUNT(1) AS total
       FROM messages
      WHERE ${where.join(" AND ")}`,
    params,
  );

  return Number(rows[0]?.total) || 0;
}

async function getLatestMessageId(conversationId, options = {}) {
  await ready;
  const pool = await getPool();
  const params = [conversationId];
  const where = ["conversation_id = ?"];

  if (Number.isFinite(options.beforeMessageId)) {
    where.push("message_id < ?");
    params.push(Number(options.beforeMessageId));
  }

  const [rows] = await pool.execute(
    `SELECT MAX(message_id) AS latest_message_id
       FROM messages
      WHERE ${where.join(" AND ")}`,
    params,
  );

  return Number(rows[0]?.latest_message_id) || 0;
}
// 更新对话标题
async function updateConversationTitle(conversationId, userId, title) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?",
    [title, conversationId, userId],
  );

  if (result.affectedRows < 1) {
    return null;
  }

  return getConversationById(conversationId);
}
// 删除对话
async function deleteConversation(conversationId, userId) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId],
  );
  return result.affectedRows > 0;
}

module.exports = {
  createConversation,
  getConversationById,
  assertConversationOwner,
  addMessage,
  listConversations,
  getMessages,
  getMessagesAfter,
  countMessagesAfter,
  getLatestMessageId,
  updateConversationTitle,
  deleteConversation,
};
