const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
process.env.JWT_SECRET = "user-keys-test-access";
process.env.REFRESH_SECRET = "user-keys-test-refresh";
process.env.USER_API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.DASHSCOPE_API_KEY = "platform-key-must-never-be-used";
process.env.DEEPSEEK_API_KEY = "platform-deepseek-must-never-be-used";
const credentials = require("../services/userCredentials");
const { encryptKey, decryptKey, withCredentials, getRequestApiKey } = credentials;
const { getClientForModel, getLangChainModelForName, assertSupportedModel, MODEL_REGISTRY } = require("../services/modelRegistry");

// The database boundary is in memory; HTTP auth, repository SQL ownership and
// credential encryption/decryption all run as in production.
const rows = new Map();
const pool = require("../db/pool");
pool.ready = Promise.resolve();
pool.getPool = async () => ({
  async execute(sql, values) {
    if (sql.startsWith("INSERT INTO user_api_keys")) {
      const [user_id, provider, encrypted_key, key_last_four] = values;
      rows.set(`${user_id}:${provider}`, { user_id, provider, encrypted_key, key_last_four });
      return [{}];
    }
    if (sql.startsWith("DELETE FROM user_api_keys")) {
      rows.delete(`${values[0]}:${values[1]}`);
      return [{}];
    }
    if (sql.includes("FROM user_api_keys WHERE user_id = ?")) {
      return [[...rows.values()].filter(row => row.user_id === values[0])];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  },
});
const repo = require("../repositories/userApiKeyRepo");
const conversationService = require("../services/conversationService");
const attachmentRepo = require("../repositories/attachmentRepo");
const orchestrator = require("../services/chatOrchestrator");
let messageWrites = 0;
let captured = [];
conversationService.ensureConversation = async () => ({ ok: true, conversationId: "test-conversation" });
conversationService.addAssistantMessage = async () => ({ message_id: 2 });
conversationService.updateAssistantMessage = async () => ({});
attachmentRepo.conversationHasAttachments = async () => false;
attachmentRepo.conversationHasImages = async () => false;
attachmentRepo.addUserMessage = async () => { messageWrites++; return { message_id: 1 }; };
orchestrator.run = async input => {
  await new Promise(resolve => setTimeout(resolve, 10));
  captured.push(getClientForModel(input.model).client.apiKey);
  if (input.content === "simulate-invalid") throw Object.assign(new Error("upstream echoed sk-do-not-leak"), { status: 401 });
  if (input.content === "simulate-balance") throw Object.assign(new Error("sk-do-not-leak"), { status: 402 });
  if (input.content === "simulate-limit") throw Object.assign(new Error("sk-do-not-leak"), { status: 429 });
  input.onChunk("reply");
  return { fullResponse: "reply", mode: "direct_chat" };
};
const jwt = require("jsonwebtoken");
require("../repositories/userRepo").getUserById = async id => ({ id, role: "admin", session_version: 0 });
let server, base;
before(async () => {
  server = require("../index").createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise(resolve => server.close(resolve)));
function request(path, userId, method = "GET", body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { Authorization: `Bearer ${jwt.sign({ id: userId, role: "admin" }, process.env.JWT_SECRET)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("authenticated settings encrypt keys and isolate accounts, even administrators", async () => {
  assert.equal((await request("/model-settings")).status, 401);
  assert.equal((await request("/model-settings/dashscope", 1, "PUT", { apiKey: "sk-user-one-1111", user_id: 2 })).status, 200);
  const stored = rows.get("1:dashscope");
  assert.ok(stored.encrypted_key.startsWith("v1:"));
  assert.ok(!stored.encrypted_key.includes("sk-user-one"));
  assert.equal((await repo.load(1)).dashscope, "sk-user-one-1111");
  const response = await request("/model-settings", 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.ok(!body.includes("encrypted_key") && !body.includes("sk-user-one"));
  assert.match(body, /1111/);
  const userTwo = await (await request("/model-settings", 2)).json();
  assert.ok(userTwo.providers.every(item => !item.configured));
  await request("/model-settings/dashscope", 2, "DELETE", { user_id: 1 });
  assert.equal((await repo.load(1)).dashscope, "sk-user-one-1111");
  assert.equal((await request("/model-settings/moonshot", 1, "PUT", { apiKey: "sk-rejected-key" })).status, 400);
  assert.equal((await request("/model-settings/__proto__", 1, "PUT", { apiKey: "sk-rejected-key" })).status, 400);
  assert.equal((await request("/model-settings/deepseek", 1, "PUT", { apiKey: "bad key" })).status, 400);
  assert.equal((await request("/model-settings/deepseek", 1, "PUT", {})).status, 400);
});

test("AEAD rejects swapped owner, provider, ciphertext and master key", () => {
  const encrypted = encryptKey(1, "dashscope", "sk-encryption-test");
  assert.equal(decryptKey(1, "dashscope", encrypted), "sk-encryption-test");
  assert.notEqual(encryptKey(1, "dashscope", "sk-encryption-test"), encrypted);
  assert.throws(() => decryptKey(2, "dashscope", encrypted), /无法读取/);
  assert.throws(() => decryptKey(1, "deepseek", encrypted), /无法读取/);
  assert.throws(() => decryptKey(1, "dashscope", `${encrypted.slice(0, -8)}AAAAAAAA`), /无法读取/);
  const previous = process.env.USER_API_KEY_ENCRYPTION_KEY;
  process.env.USER_API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.throws(() => decryptKey(1, "dashscope", encrypted), /无法读取/);
  delete process.env.USER_API_KEY_ENCRYPTION_KEY;
  assert.throws(() => encryptKey(1, "dashscope", "sk-encryption-test"), /加密密钥/);
  process.env.USER_API_KEY_ENCRYPTION_KEY = previous;
});

test("model factories never fall back to platform env keys; only two providers exist", async () => {
  assert.throws(() => getClientForModel("qwen-plus"), /配置你自己的/);
  assert.throws(() => getLangChainModelForName("deepseek-v4-pro"), /配置你自己的/);
  assert.throws(() => assertSupportedModel("kimi-k2.5"), /unsupported model/);
  assert.throws(() => assertSupportedModel("__proto__"), /unsupported model/);
  assert.deepEqual([...new Set(Object.values(MODEL_REGISTRY).map(item => item.provider))].sort(), ["dashscope", "deepseek"]);
  await Promise.all([1, 2, 3].map(id => withCredentials({ dashscope: `user-${id}-key` }, async () => {
    await new Promise(resolve => setTimeout(resolve, 4 - id));
    assert.equal(getClientForModel("qwen-plus").client.apiKey, `user-${id}-key`);
    assert.equal(getLangChainModelForName("qwen-plus").apiKey, `user-${id}-key`);
  })));
  assert.equal(getRequestApiKey("dashscope", false), null);
});

test("HTTP chat validates credentials before writing messages and uses each account's key", async () => {
  captured = [];
  const writesBefore = messageWrites;
  const missing = await request("/conversations", 3, "POST", { content: "hello", model: "qwen-plus", apiKey: "body-key-must-not-be-trusted", user_id: 1 });
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /配置你自己的/);
  assert.equal(messageWrites, writesBefore);
  await request("/model-settings/dashscope", 2, "PUT", { apiKey: "sk-user-two-2222" });
  const responses = await Promise.all([1, 2].map(id => request("/conversations", id, "POST", { content: "hello", model: "qwen-plus" })));
  for (const response of responses) { assert.equal(response.status, 200); assert.match(await response.text(), /reply/); }
  assert.deepEqual(captured.sort(), ["sk-user-one-1111", "sk-user-two-2222"]);
  const invalid = await request("/conversations", 1, "POST", { content: "simulate-invalid", model: "qwen-plus" });
  const output = await invalid.text();
  assert.match(output, /检查密钥和权限/);
  assert.ok(!output.includes("sk-do-not-leak"));
  for (const [content, expected] of [["simulate-balance", /余额不足/], ["simulate-limit", /额度不足/]]) {
    const response = await request("/conversations", 1, "POST", { content, model: "qwen-plus" });
    const body = await response.text();
    assert.match(body, expected);
    assert.ok(!body.includes("sk-do-not-leak"));
  }
  await request("/model-settings/dashscope", 1, "PUT", { apiKey: "sk-user-one-replaced" });
  assert.equal((await repo.load(1)).dashscope, "sk-user-one-replaced");
  await request("/model-settings/dashscope", 1, "DELETE");
  assert.equal((await request("/conversations", 1, "POST", { content: "hello" })).status, 400);
  await request("/model-settings/deepseek", 1, "PUT", { apiKey: "sk-deepseek-own-key" });
  const deepseek = await request("/conversations", 1, "POST", { content: "hello", model: "deepseek-v4-pro" });
  assert.match(await deepseek.text(), /reply/);
  assert.equal(captured.at(-1), "sk-deepseek-own-key");
  assert.equal((await request("/conversations", 1, "POST", { content: "hello", model: "kimi-k2.5" })).status, 400);
});

test("RAG uses request-owned Bailian key only for loopback and refuses redirects", async () => {
  const rag = require("../services/ragService");
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(options.headers["X-Dashscope-Api-Key"], "sk-rag-personal-key");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { query: "copper", history: [] });
    return { ok: true, json: async () => ({ mode: "local_rag", contextText: "C11000" }) };
  };
  const invoke = ragUrl => rag.retrieveContext({ query: "copper", history: [], options: { fetchImpl, ragUrl } });
  const noKey = await invoke("http://localhost:8001/rag/retrieve");
  assert.equal(noKey.meta.reason, "missing_user_dashscope_key");
  assert.equal(calls, 0);
  await withCredentials({ dashscope: "sk-rag-personal-key" }, async () => {
    assert.equal((await invoke("http://127.0.0.1:8001/rag/retrieve")).contextText, "C11000");
    for (const url of ["https://untrusted.example/rag/retrieve", "http://localhost.evil.example/rag", "http://192.168.1.2/rag"]) {
      assert.equal((await invoke(url)).meta.reason, "remote_rag_disabled");
    }
  });
  assert.equal(calls, 1);
});
