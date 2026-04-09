const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");
// ragService.js - 处理检索增强生成（RAG）相关的业务逻辑
const DEFAULT_RAG_URL =
  process.env.RAG_SERVICE_URL || "http://localhost:8001/rag/retrieve";
// 提供一个函数 retrieveContext 来调用 RAG 服务，获取与用户查询相关的上下文信息
async function retrieveContext({ query, history, options = {} }) {
  const timeoutMs = options.timeoutMs || 15000;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  // 在指定的超时时间后调用 controller.abort() 来取消请求
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    // 向 RAG 服务发送 POST 请求，包含用户的查询和对话历史
    const response = await fetch(DEFAULT_RAG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, history }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`rag retrieve failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return {
      mode: data.mode || "local_rag",
      contextText: data.contextText || "",
      meta: data.meta || {},
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  retrieveContext,
};
