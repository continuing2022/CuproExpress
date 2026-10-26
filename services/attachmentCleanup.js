const { getPool } = require("../db/pool");
const storage = require("./attachmentStorage");
let running = false;
async function cleanupAttachments() {
  if (running) return;
  running = true;
  try {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [expired] = await connection.execute("SELECT attachment_id, object_key FROM attachments WHERE message_id IS NULL AND created_at < NOW() - INTERVAL 1 DAY LIMIT 100 FOR UPDATE");
      for (const file of expired) {
        await connection.execute("INSERT IGNORE INTO attachment_cleanup (object_key) VALUES (?)", [file.object_key]);
        await connection.execute("DELETE FROM attachments WHERE attachment_id = ?", [file.attachment_id]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    const [pending] = await pool.execute("SELECT object_key FROM attachment_cleanup ORDER BY created_at LIMIT 100");
    for (const file of pending) {
      try {
        await storage.remove(file.object_key);
        await pool.execute("DELETE FROM attachment_cleanup WHERE object_key = ?", [file.object_key]);
      } catch { /* Keep failed deletions queued for the next run. */ }
    }
  } finally { running = false; }
}
module.exports = { cleanupAttachments };
