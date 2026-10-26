const { getPool, ready } = require("../db/pool");
const { PROVIDERS, encryptKey, decryptKey, normalizeKey, assertProvider } = require("../services/userCredentials");

async function list(userId) {
  await ready;
  const [rows] = await (await getPool()).execute(
    "SELECT provider, key_last_four, updated_at FROM user_api_keys WHERE user_id = ?", [userId],
  );
  return Object.entries(PROVIDERS).map(([provider, name]) => {
    const row = rows.find(item => item.provider === provider);
    return { provider, name, configured: Boolean(row), maskedKey: row ? `••••${row.key_last_four}` : "", updatedAt: row?.updated_at || null };
  });
}

async function save(userId, provider, value) {
  assertProvider(provider);
  const key = normalizeKey(value);
  const encrypted = encryptKey(userId, provider, key);
  await ready;
  await (await getPool()).execute(
    "INSERT INTO user_api_keys (user_id, provider, encrypted_key, key_last_four) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE encrypted_key = VALUES(encrypted_key), key_last_four = VALUES(key_last_four), updated_at = CURRENT_TIMESTAMP",
    [userId, provider, encrypted, key.slice(-4)],
  );
}

async function remove(userId, provider) {
  assertProvider(provider);
  await ready;
  await (await getPool()).execute("DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?", [userId, provider]);
}

async function load(userId) {
  await ready;
  const [rows] = await (await getPool()).execute("SELECT provider, encrypted_key FROM user_api_keys WHERE user_id = ?", [userId]);
  const keys = {};
  for (const row of rows) {
    if (Object.hasOwn(PROVIDERS, row.provider)) keys[row.provider] = decryptKey(userId, row.provider, row.encrypted_key);
  }
  return keys;
}

module.exports = { list, save, remove, load };
