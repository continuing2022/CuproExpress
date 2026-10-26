const { randomUUID } = require("crypto");
const { getPool } = require("../db/pool");
const storage = require("../services/attachmentStorage");

const metadataColumns = "attachment_id AS id, message_id, name, mime_type AS mimeType, size";

async function create(userId, file) {
  const pool = await getPool();
  const id = randomUUID();
  const key = `chat-attachments/${userId}/${id}`;
  await storage.put(key, file);
  try {
    await pool.execute(
      "INSERT INTO attachments (attachment_id, user_id, name, mime_type, size, object_key, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, userId, file.name, file.mimeType, file.size, key, file.text || null],
    );
  } catch (error) { await storage.remove(key).catch(() => {}); throw error; }
  return { id, name: file.name, mimeType: file.mimeType, size: file.size };
}

async function getOwned(id, userId) {
  const pool = await getPool();
  const [rows] = await pool.execute(`SELECT ${metadataColumns}, object_key, extracted_text AS text FROM attachments WHERE attachment_id = ? AND user_id = ?`, [id, userId]);
  return rows[0] || null;
}

async function removePending(id, userId) {
  const pool = await getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT object_key FROM attachments WHERE attachment_id = ? AND user_id = ? AND message_id IS NULL FOR UPDATE", [id, userId]);
    if (rows[0]) {
      await storage.remove(rows[0].object_key);
      await connection.execute("DELETE FROM attachments WHERE attachment_id = ?", [id]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function forMessages(messageIds, includeContent = false) {
  if (!messageIds.length) return [];
  const pool = await getPool();
  const [rows] = await pool.execute(
    `SELECT ${metadataColumns}${includeContent ? ", object_key, extracted_text AS text" : ""} FROM attachments WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY created_at, attachment_id`,
    messageIds,
  );
  if (includeContent) {
    for (const row of rows) if (row.mimeType.startsWith("image/")) row.data = await storage.get(row.object_key);
  }
  return rows;
}

async function conversationHasImages(conversationId) {
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT 1 FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.conversation_id = ? AND a.mime_type LIKE 'image/%' LIMIT 1", [conversationId]);
  return rows.length > 0;
}

async function conversationHasAttachments(conversationId) {
  const pool = await getPool();
  const [rows] = await pool.execute("SELECT 1 FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.conversation_id = ? LIMIT 1", [conversationId]);
  return rows.length > 0;
}

async function addUserMessage(conversationId, userId, content, ids) {
  const pool = await getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (ids.length) {
      const [files] = await connection.execute(`SELECT attachment_id FROM attachments WHERE attachment_id IN (${ids.map(() => "?").join(",")}) AND user_id = ? AND message_id IS NULL FOR UPDATE`, [...ids, userId]);
      if (files.length !== ids.length) throw Object.assign(new Error("附件不存在、已发送或无权访问，请重新上传"), { statusCode: 400 });
    }
    const [result] = await connection.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)", [conversationId, content]);
    if (ids.length) await connection.execute(`UPDATE attachments SET message_id = ? WHERE attachment_id IN (${ids.map(() => "?").join(",")})`, [result.insertId, ...ids]);
    await connection.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?", [conversationId]);
    await connection.commit();
    return { message_id: result.insertId };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

module.exports = { create, getOwned, removePending, forMessages, conversationHasImages, conversationHasAttachments, addUserMessage };
