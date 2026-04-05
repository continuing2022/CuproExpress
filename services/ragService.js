const fetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : require("node-fetch");

const DEFAULT_RAG_URL =
  process.env.RAG_SERVICE_URL || "http://localhost:8001/rag/retrieve";

async function retrieveContext({ query, history, options = {} }) {
  const timeoutMs = options.timeoutMs || 8000;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
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
