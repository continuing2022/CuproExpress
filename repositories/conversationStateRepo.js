const { getPool, ready } = require("../db/pool");

async function getConversationState(conversationId) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT conversation_id, running_summary, summary_version,
            last_summarized_message_id, summary_boundary_verified, last_summary_at, memory_facts_json,
            updated_at
       FROM conversation_states
      WHERE conversation_id = ?`,
    [conversationId],
  );

  if (!rows[0]) return null;
  // 返回该会话的信息
  return {
    ...rows[0],
    memory_facts_json: normalizeJsonField(rows[0].memory_facts_json),
  };
}

async function ensureConversationState(conversationId) {
  const existing = await getConversationState(conversationId);
  if (existing) return existing;

  await ready;
  const pool = await getPool();
  // 创建一条新的数据记录，使用 INSERT IGNORE 来避免重复插入
  await pool.execute(
    `INSERT IGNORE INTO conversation_states
      (conversation_id, running_summary, summary_version,
       last_summarized_message_id, memory_facts_json)
     VALUES (?, '', 0, 0, JSON_ARRAY())`,
    [conversationId],
  );

  return getConversationState(conversationId);
}

async function updateConversationSummary({
  conversationId,
  runningSummary,
  summaryVersion,
  lastSummarizedMessageId,
}) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    `UPDATE conversation_states
        SET running_summary = ?, summary_version = summary_version + 1,
            last_summarized_message_id = ?, summary_boundary_verified = TRUE,
            last_summary_at = CURRENT_TIMESTAMP
      WHERE conversation_id = ? AND summary_version = ?
        AND (summary_boundary_verified = FALSE OR last_summarized_message_id <= ?)`,
    [runningSummary, lastSummarizedMessageId, conversationId, summaryVersion, lastSummarizedMessageId],
  );
  return result.affectedRows === 1;
}

function normalizeJsonField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
}

module.exports = {
  getConversationState,
  ensureConversationState,
  updateConversationSummary,
};
