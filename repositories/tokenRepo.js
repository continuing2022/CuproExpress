const { createHash } = require("crypto");
const { getPool, ready } = require("../db/pool");

function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

async function saveRefreshToken({ userId, token, expiresAt, rememberMe = true }) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [result] = await pool.execute(
    "INSERT INTO refresh_tokens (user_id, token, expires_at, remember_me) VALUES (?, ?, ?, ?)",
    [userId, tokenHash, expiresAt, rememberMe],
  );
  return result.insertId;
}

async function rotateRefreshToken({ token, payload, issueTokens }) {
  const connection = await (await getPool()).getConnection();
  try {
    await connection.beginTransaction();
    // Match password reset's lock order so refresh cannot escape revocation.
    const [[user]] = await connection.execute("SELECT * FROM users WHERE id = ? FOR UPDATE", [payload.id]);
    let result = { status: "invalid" };
    if (user && (payload.sv ?? 0) === user.session_version) {
      const tokenHash = hashToken(token);
      const [[stored]] = await connection.execute(
        `SELECT *, expires_at > NOW() AS unexpired,
          rotated_at >= DATE_SUB(NOW(3), INTERVAL 5 SECOND) AS rotation_recent
         FROM refresh_tokens WHERE user_id = ? AND token IN (?, ?)
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [user.id, tokenHash, token],
      );
      if (stored?.unexpired) {
        if (stored.revoked && stored.rotated_at) {
          if (stored.rotation_recent) {
            result = { status: "conflict" };
          } else {
            // A consumed credential replayed outside the race window indicates
            // compromise. Revoke access and refresh credentials on all devices.
            await connection.execute("UPDATE users SET session_version = session_version + 1 WHERE id = ?", [user.id]);
            await connection.execute("UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?", [user.id]);
            result = { status: "replayed" };
          }
        } else if (!stored.revoked) {
          const tokens = issueTokens(user);
          await connection.execute(
            "UPDATE refresh_tokens SET revoked = TRUE, rotated_at = NOW(3) WHERE user_id = ? AND token IN (?, ?) AND revoked = FALSE",
            [user.id, tokenHash, token],
          );
          await connection.execute(
            "INSERT INTO refresh_tokens (user_id, token, expires_at, remember_me) VALUES (?, ?, ?, ?)",
            [user.id, hashToken(tokens.refreshToken), tokens.expiresAt, stored.remember_me],
          );
          result = { status: "ok", ...tokens, rememberMe: Boolean(stored.remember_me) };
        }
      }
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [rows] = await pool.execute(
    "SELECT * FROM refresh_tokens WHERE token IN (?, ?) LIMIT 1",
    [tokenHash, token],
  );
  return rows[0] || null;
}

async function revokeRefreshToken(token) {
  await ready;
  const pool = await getPool();
  const tokenHash = hashToken(token);
  const [result] = await pool.execute(
    "UPDATE refresh_tokens SET revoked = TRUE WHERE token IN (?, ?)",
    [tokenHash, token],
  );
  return result.affectedRows > 0;
}

async function revokeRefreshTokensByUserId(userId) {
  await ready;
  const pool = await getPool();
  const [result] = await pool.execute(
    "UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?",
    [userId],
  );
  return result.affectedRows || 0;
}

module.exports = {
  saveRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokensByUserId,
  rotateRefreshToken,
};
