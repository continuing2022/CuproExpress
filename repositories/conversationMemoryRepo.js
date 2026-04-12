const { getPool, ready } = require("../db/pool");

async function createMemoryChunks(chunks = []) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  await ready;
  const pool = await getPool();
  const values = chunks.map((chunk) => [
    chunk.conversationId,
    chunk.sourceMessageStartId,
    chunk.sourceMessageEndId,
    chunk.content,
    chunk.memoryType || "general",
    chunk.embedding ? JSON.stringify(chunk.embedding) : null,
    JSON.stringify(Array.isArray(chunk.keywords) ? chunk.keywords : []),
  ]);

  await pool.query(
    `INSERT IGNORE INTO conversation_memory_chunks
      (conversation_id, source_message_start_id, source_message_end_id,
       content, memory_type, embedding, keywords_json)
     VALUES ?`,
    [values],
  );

  return chunks;
}

async function listMemoryChunks(conversationId, options = {}) {
  await ready;
  const pool = await getPool();
  const params = [conversationId];
  const where = ["conversation_id = ?"];

  if (Number.isFinite(options.beforeMessageId)) {
    where.push("source_message_end_id < ?");
    params.push(Number(options.beforeMessageId));
  }

  if (Number.isFinite(options.maxSourceMessageId)) {
    where.push("source_message_end_id <= ?");
    params.push(Number(options.maxSourceMessageId));
  }

  const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
  const [rows] = await pool.execute(
    `SELECT memory_id, conversation_id, source_message_start_id,
            source_message_end_id, content, memory_type, embedding,
            keywords_json, created_at
       FROM conversation_memory_chunks
      WHERE ${where.join(" AND ")}
      ORDER BY source_message_end_id DESC, memory_id DESC
      LIMIT ${limit}`,
    params,
  );

  return rows.map((row) => ({
    ...row,
    keywords_json: normalizeJsonField(row.keywords_json),
  }));
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
  createMemoryChunks,
  listMemoryChunks,
};
