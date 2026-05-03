const { getPool, ready } = require("../db/pool");

async function getConversationState(conversationId) {
  await ready;
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT conversation_id, running_summary, summary_version,
            last_summarized_message_id, last_summary_at, memory_facts_json,
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

async function upsertConversationState({
  conversationId,
  runningSummary,
  summaryVersion,
  lastSummarizedMessageId,
  memoryFacts,
}) {
  await ready;
  const pool = await getPool();
  await pool.execute(
    `INSERT INTO conversation_states
      (conversation_id, running_summary, summary_version,
       last_summarized_message_id, last_summary_at, memory_facts_json)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE
       running_summary = VALUES(running_summary),
       summary_version = VALUES(summary_version),
       last_summarized_message_id = VALUES(last_summarized_message_id),
       last_summary_at = VALUES(last_summary_at),
       memory_facts_json = VALUES(memory_facts_json)`,
    [
      conversationId,
      runningSummary || "",
      Number(summaryVersion) || 0,
      Number(lastSummarizedMessageId) || 0,
      JSON.stringify(Array.isArray(memoryFacts) ? memoryFacts : []),
    ],
  );

  return getConversationState(conversationId);
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
  upsertConversationState,
};
