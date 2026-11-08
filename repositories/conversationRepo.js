const { randomUUID } = require("crypto");
const { getPool, ready } = require("../db/pool");

function toFiniteInteger(value, options = {}) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return options.defaultValue ?? null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return options.defaultValue ?? null;
  }

  let normalized = Math.floor(parsed);
  if (Number.isFinite(options.min)) {
    normalized = Math.max(options.min, normalized);
  }
  if (Number.isFinite(options.max)) {
    normalized = Math.min(options.max, normalized);
  }

  if (Number.isFinite(options.min) && normalized < options.min) {
    return options.defaultValue ?? null;
  }
  return normalized;
}

async function createConversation(userId, title = "New Conversation") {
  await ready;
  const pool = await getPool();
  const conversationId = randomUUID();
  await pool.execute(
    "INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)",
    [conversationId, userId, title],
  );
  return { conversation_id: conversationId, user_id: userId, title };
}

async function getConversationById(conversationId) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM conversations WHERE conversation_id = ?",
    [conversationId],
  );
  return rows[0] || null;
}

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

async function addMessage(conversationId, role, content, { status = "done" } = {}) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "INSERT INTO messages (conversation_id, role, content, status) VALUES (?, ?, ?, ?)",
    [conversationId, role, content, status],
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
    status,
  };
}

async function updateAssistantMessage(messageId, content, status) {
  const pool = await getPool();
  const [result] = await pool.execute("UPDATE messages SET content = ?, status = ? WHERE message_id = ? AND role = 'assistant' AND status = 'streaming'", [content, status, messageId]);
  if (result.affectedRows !== 1) throw new Error("Assistant message is missing or already finalized");
  return { message_id: messageId, content, status };
}

async function listConversations(userId, page = 1, pageSize = 20) {
  await ready;
  const pool = await getPool();
  const safePage = toFiniteInteger(page, { min: 1, defaultValue: 1 });
  const safePageSize = toFiniteInteger(pageSize, {
    min: 1,
    max: 100,
    defaultValue: 20,
  });
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

async function getMessages(conversationId, limitOrOptions = null) {
  await ready;
  const pool = await getPool();

  const options =
    limitOrOptions &&
    typeof limitOrOptions === "object" &&
    !Array.isArray(limitOrOptions)
      ? limitOrOptions
      : { limit: limitOrOptions };

  const shouldApplyLimit = !(
    options.limit === null ||
    options.limit === undefined ||
    String(options.limit).trim() === ""
  );
  const safeLimit = shouldApplyLimit
    ? toFiniteInteger(options.limit, {
        min: 1,
        max: 500,
        defaultValue: null,
      })
    : null;
  const safeBeforeMessageId = toFiniteInteger(options.beforeMessageId, {
    min: 1,
    defaultValue: null,
  });

  const params = [conversationId];
  const where = ["conversation_id = ?"];

  if (safeBeforeMessageId) {
    where.push("message_id < ?");
    params.push(safeBeforeMessageId);
  }

  if (!safeLimit) {
    const [rows] = await pool.execute(
      `SELECT message_id, role, content, status, created_at
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC, message_id ASC`,
      params,
    );
    return rows;
  }

  const [rows] = await pool.execute(
    `SELECT message_id, role, content, status, created_at
     FROM messages
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, message_id DESC
     LIMIT ${safeLimit}`,
    params,
  );

  return rows.reverse();
}

async function getMessagesAfter(
  conversationId,
  afterMessageId = 0,
  options = {},
) {
  await ready;
  const pool = await getPool();

  const safeAfterMessageId = toFiniteInteger(afterMessageId, {
    min: 0,
    defaultValue: 0,
  });

  const { forRecovery = false } = options;
  const params = [conversationId, safeAfterMessageId];
  const where = ["conversation_id = ?", "message_id > ?"];

  if (forRecovery) where.push("(role <> 'assistant' OR status = 'done')");

  const beforeMessageId = toFiniteInteger(options.beforeMessageId, {
    min: 1,
    defaultValue: null,
  });
  if (beforeMessageId) {
    where.push("message_id < ?");
    params.push(beforeMessageId);
  }

  const limit = toFiniteInteger(options.limit, {
    min: 1,
    max: 500,
    defaultValue: null,
  });
  const limitSql = limit ? ` LIMIT ${limit}` : "";

  const order = forRecovery ? "message_id DESC" : "created_at ASC, message_id ASC";
  const [rows] = await pool.execute(
    `SELECT message_id, role, content, status, created_at
       FROM messages
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}${limitSql}`,
    params,
  );

  return forRecovery ? rows.reverse() : rows;
}

async function countMessagesAfter(
  conversationId,
  afterMessageId = 0,
  options = {},
) {
  await ready;
  const pool = await getPool();

  const safeAfterMessageId = toFiniteInteger(afterMessageId, {
    min: 0,
    defaultValue: 0,
  });

  const params = [conversationId, safeAfterMessageId];
  const where = ["conversation_id = ?", "message_id > ?"];

  const beforeMessageId = toFiniteInteger(options.beforeMessageId, {
    min: 1,
    defaultValue: null,
  });
  if (beforeMessageId) {
    where.push("message_id < ?");
    params.push(beforeMessageId);
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

  const beforeMessageId = toFiniteInteger(options.beforeMessageId, {
    min: 1,
    defaultValue: null,
  });
  if (beforeMessageId) {
    where.push("message_id < ?");
    params.push(beforeMessageId);
  }

  const [rows] = await pool.execute(
    `SELECT MAX(message_id) AS latest_message_id
       FROM messages
      WHERE ${where.join(" AND ")}`,
    params,
  );

  return Number(rows[0]?.latest_message_id) || 0;
}

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

async function deleteConversation(conversationId, userId) {
  await ready;
  const pool = await getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [owned] = await connection.execute("SELECT conversation_id FROM conversations WHERE conversation_id = ? AND user_id = ? FOR UPDATE", [conversationId, userId]);
    if (!owned.length) { await connection.rollback(); return false; }
    await connection.execute("INSERT IGNORE INTO attachment_cleanup (object_key) SELECT a.object_key FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.conversation_id = ?", [conversationId]);
    await connection.execute("DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?", [conversationId, userId]);
    await connection.commit();
    return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

module.exports = {
  createConversation,
  getConversationById,
  assertConversationOwner,
  addMessage,
  updateAssistantMessage,
  listConversations,
  getMessages,
  getMessagesAfter,
  countMessagesAfter,
  getLatestMessageId,
  updateConversationTitle,
  deleteConversation,
};
