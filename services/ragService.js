const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");
// ragService.js - 处理检索增强生成（RAG）相关的业务逻辑
const DEFAULT_RAG_URL =
  process.env.RAG_SERVICE_URL || "http://localhost:8001/rag/retrieve";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalRagUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return LOCAL_HOSTS.has(parsed.hostname);
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

async function fetchWithTimeout(fetchImpl, url, payload, timeoutMs) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 提供一个函数 retrieveContext 来调用 RAG 服务，获取与用户查询相关的上下文信息
async function retrieveContext({ query, history, options = {} }) {
  const timeoutMs = options.timeoutMs || 15000;
  const startedAt = Date.now();
  const ragUrl = options.ragUrl || DEFAULT_RAG_URL;
  const fetchImpl = options.fetchImpl || fetch;
  const maxAttempts =
    options.retryAttempts || (isLocalRagUrl(ragUrl) ? 3 : 1);
  const retryDelayMs =
    options.retryDelayMs === undefined ? 500 : Number(options.retryDelayMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // 向 RAG 服务发送 POST 请求，包含用户的查询和对话历史
      const response = await fetchWithTimeout(
        fetchImpl,
        ragUrl,
        { query, history },
        timeoutMs,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`rag retrieve failed: ${response.status} ${text}`);
      }

      const data = await response.json();
      return {
        mode: data.mode || "local_rag",
        contextText: data.contextText || "",
        meta: {
          ...(data.meta || {}),
          ragServiceLatencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const shouldRetry =
        attempt < maxAttempts &&
        isLocalRagUrl(ragUrl) &&
        isRetryableLocalFetchError(error);
      if (!shouldRetry) throw error;
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
}

module.exports = {
  isLocalRagUrl,
  isRetryableLocalFetchError,
  retrieveContext,
};
