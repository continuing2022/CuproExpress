// 优先使用 Node.js 内置的 global fetch（Node 18+），仅在不存在时回退到 node-fetch
const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");

async function getRagCompletionStream(query, history, onChunk, options = {}) {
  const RAG_URL =
    process.env.RAG_SERVICE_URL || "http://localhost:8001/rag/stream";
  const timeoutMs = options.timeoutMs || 5000;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;
  let timer = null;
  if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(RAG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, history }),
      signal,
    });

    if (!response.ok) {
      console.error(`RAG服务返回非200: ${response.status}`);
      return; // 优雅降级，调用方继续执行
    }

    for await (const chunk of response.body) {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        if (data.error) {
          console.error("RAG 服务错误数据:", data.error);
          return;
        }
        if (data.chunk) onChunk(data.chunk);
        if (data.done) return;
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`RAG 请求超时（${timeoutMs}ms），已放弃`);
    } else {
      console.error("检索服务错误:", err);
    }
    // 不抛出，回到调用者由 LLM 等其他策略继续处理
    return;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { getRagCompletionStream };
