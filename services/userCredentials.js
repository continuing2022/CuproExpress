const { AsyncLocalStorage } = require("node:async_hooks");
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");

const credentials = new AsyncLocalStorage();
const PROVIDERS = Object.freeze({ dashscope: "阿里云百炼", deepseek: "DeepSeek", bocha: "博查联网搜索" });

function credentialError(message, statusCode = 400, code = "INVALID_API_KEY") {
  return Object.assign(new Error(message), { statusCode, code });
}

function assertProvider(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw credentialError("仅支持阿里云百炼、DeepSeek 和博查", 400, "UNSUPPORTED_PROVIDER");
  return provider;
}

function encryptionKey() {
  const value = process.env.USER_API_KEY_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw credentialError("服务端尚未配置 API Key 加密密钥，请联系管理员", 503, "KEY_ENCRYPTION_UNAVAILABLE");
  }
  return Buffer.from(value, "hex");
}

function normalizeKey(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{8,512}$/.test(value.trim())) {
    throw credentialError("请输入有效的 API Key（8–512 个非空白 ASCII 字符）");
  }
  return value.trim();
}

// Bind ciphertext to its owner/provider so rows cannot be swapped between accounts.
function encryptKey(userId, provider, value) {
  const key = normalizeKey(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:${assertProvider(provider)}`));
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

function decryptKey(userId, provider, value) {
  const masterKey = encryptionKey();
  try {
    const [version, iv, tag, encrypted] = value.split(":");
    if (version !== "v1") throw new Error("version");
    const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`${userId}:${assertProvider(provider)}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw credentialError("无法读取已保存的 API Key，请重新配置或联系管理员", 503, "KEY_DECRYPTION_FAILED");
  }
}

function getRequestApiKey(provider, required = true) {
  assertProvider(provider);
  const key = credentials.getStore()?.[provider];
  if (!key && required) throw credentialError(`请在“模型服务设置”中配置你自己的 ${PROVIDERS[provider]} API Key`, 400, "MISSING_USER_API_KEY");
  return key || null;
}

function withCredentials(keys, work) {
  return credentials.run(Object.freeze({ ...keys }), work);
}

module.exports = { PROVIDERS, assertProvider, normalizeKey, encryptKey, decryptKey, getRequestApiKey, withCredentials };
