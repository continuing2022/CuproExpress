const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");
// ragService.js - 处理检索增强生成（RAG）相关的业务逻辑
const DEFAULT_RAG_URL =
  process.env.RAG_SERVICE_URL || "http://localhost:8001/rag/retrieve";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const { getRequestApiKey } = require("./userCredentials");
const { abortable } = require("../utils/cancellation");

async function sleep(ms, signal) {
  let timer;
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

function isLocalRagUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ["http:", "https:"].includes(parsed.protocol) && LOCAL_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

function getErrorCode(error) {
  return (
    error?.code ||
    error?.cause?.code ||
    error?.errno ||
    error?.cause?.errno ||
    ""
  );
}

function isRetryableLocalFetchError(error) {
  if (error?.name === "AbortError") return false;
  const code = String(getErrorCode(error));
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(code)) {
    return true;
  }
  return /fetch failed|network/i.test(String(error?.message || ""));
}

async function fetchWithTimeout(fetchImpl, url, payload, timeoutMs, apiKey, signal) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const onAbort = () => controller?.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const response = await abortable(fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashscope-Api-Key": apiKey },
      redirect: "error",
      body: JSON.stringify(payload),
      signal: controller?.signal,
    }), controller?.signal);
    if (!response.ok) throw new Error(`知识库检索暂不可用（${response.status}），请检查个人百炼 Key 和知识库索引`);
    // Keep the deadline active while consuming the body, not only headers.
    return await abortable(response.json(), controller?.signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  }
}

// 提供一个函数 retrieveContext 来调用 RAG 服务，获取与用户查询相关的上下文信息
async function retrieveContext({ query, history, options = {}, signal = options.signal }) {
  signal?.throwIfAborted();
  const apiKey = getRequestApiKey("dashscope", false);
  if (!apiKey) return {
    mode: "direct_chat", contextText: "",
    meta: { reason: "missing_user_dashscope_key", message: "知识库检索需要配置你自己的阿里云百炼 API Key；当前使用普通对话。" },
  };
  const timeoutMs = options.timeoutMs || 15000;
  const startedAt = Date.now();
  const ragUrl = options.ragUrl || DEFAULT_RAG_URL;
  if (!isLocalRagUrl(ragUrl)) {
    return { mode: "direct_chat", contextText: "", meta: { reason: "remote_rag_disabled", message: "用户密钥仅用于本机知识库服务，远程知识库检索未启用。" } };
  }
  const fetchImpl = options.fetchImpl || fetch;
  const maxAttempts =
    options.retryAttempts || (isLocalRagUrl(ragUrl) ? 3 : 1);
  const retryDelayMs =
    options.retryDelayMs === undefined ? 500 : Number(options.retryDelayMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // 向 RAG 服务发送 POST 请求，包含用户的查询和对话历史
      const data = await fetchWithTimeout(
        fetchImpl,
        ragUrl,
        { query, history },
        timeoutMs,
        apiKey,
        signal,
      );
      signal?.throwIfAborted();
      return {
        mode: data.mode || "local_rag",
        contextText: data.contextText || "",
        meta: {
          ...(data.meta || {}),
          ragServiceLatencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      signal?.throwIfAborted();
      const shouldRetry =
        attempt < maxAttempts &&
        isLocalRagUrl(ragUrl) &&
        isRetryableLocalFetchError(error);
      if (!shouldRetry) throw error;
      if (retryDelayMs > 0) await sleep(retryDelayMs, signal);
    }
  }
}

module.exports = {
  isLocalRagUrl,
  isRetryableLocalFetchError,
  retrieveContext,
};
