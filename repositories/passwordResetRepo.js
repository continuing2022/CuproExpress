const { createHash } = require("node:crypto");
const { getPool } = require("../db/pool");

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function transaction(work) {
  const connection = await (await getPool()).getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function create({ userId, email, token, expiresAt }) {
  return transaction(async (connection) => {
    // All reset operations lock the user first, including different tokens.
    const [[user]] = await connection.execute("SELECT id, email, session_version FROM users WHERE id = ? FOR UPDATE", [userId]);
    if (!user || user.email !== email) return false;
    const [[recent]] = await connection.execute(
      "SELECT token_hash FROM password_resets WHERE user_id = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 60 SECOND) LIMIT 1",
      [userId],
    );
    if (recent) return false;
    await connection.execute("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    await connection.execute(
      "INSERT INTO password_resets (token_hash, user_id, session_version, expires_at) VALUES (?, ?, ?, ?)",
      [hashToken(token), userId, user.session_version, expiresAt],
    );
    return true;
  });
}

async function remove(token) {
  await (await getPool()).execute("DELETE FROM password_resets WHERE token_hash = ?", [hashToken(token)]);
}

async function consume(token, passwordHash) {
  const tokenHash = hashToken(token);
  return transaction(async (connection) => {
    const [[reset]] = await connection.execute("SELECT user_id, session_version FROM password_resets WHERE token_hash = ?", [tokenHash]);
    if (!reset) return false;
    const [[user]] = await connection.execute("SELECT id, session_version FROM users WHERE id = ? FOR UPDATE", [reset.user_id]);
    if (!user || user.session_version !== reset.session_version) return false;
    const [result] = await connection.execute(
      "UPDATE password_resets SET consumed_at = NOW(3) WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW(3)",
      [tokenHash],
    );
    if (result.affectedRows !== 1) return false;
    await connection.execute(
      "UPDATE users SET password = ?, session_version = session_version + 1 WHERE id = ?",
      [passwordHash, user.id],
    );
    await connection.execute("UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?", [user.id]);
    await connection.execute(
      "UPDATE password_resets SET consumed_at = COALESCE(consumed_at, NOW(3)) WHERE user_id = ?",
      [user.id],
    );
    return true;
  });
}

module.exports = { create, remove, consume, hashToken };
