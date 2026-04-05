const openaiService = require("./openai");
const { AGENT_MODES, resolveMode, retrieve } = require("./retrievalService");

function sanitizeHistory(history = []) {
  return history.map((item) => ({
    role: item.role,
    content: item.content,
  }));
}

function buildMessages({ history, content, contextText }) {
  const messages = sanitizeHistory(history);

  if (contextText && contextText.trim()) {
    messages.unshift({
      role: "system",
      content:
        "以下是本轮可用的外部上下文信息。仅在内容相关且有帮助时引用，不要编造未出现的信息。\n\n" +
        contextText,
    });
  }

  messages.push({ role: "user", content });
  return messages;
}

async function run({
  content,
  model,
  networkConfig,
  history,
  onRetrieved,
  onChunk,
}) {
  const requestedMode = resolveMode({ networkConfig });
  let retrievalResult = {
    mode: AGENT_MODES.DIRECT_CHAT,
    contextText: "",
    meta: {},
  };

  if (requestedMode !== AGENT_MODES.DIRECT_CHAT) {
    try {
      retrievalResult = await retrieve({
        mode: requestedMode,
        query: content,
        history,
      });
    } catch (error) {
      console.error("retrieval failed:", error);
      retrievalResult = {
        mode: AGENT_MODES.DIRECT_CHAT,
        contextText: "",
        meta: { fallbackFrom: requestedMode, reason: "retrieval_error" },
      };
    }
  }

  if (typeof onRetrieved === "function") {
    onRetrieved(retrievalResult);
  }

  const finalMessages = buildMessages({
    history,
    content,
    contextText: retrievalResult.contextText,
  });

  const fullResponse = await openaiService.getChatCompletionStream(
    finalMessages,
    onChunk,
    { max_tokens: 2000, model },
  );

  return {
    fullResponse,
    mode: retrievalResult.mode || AGENT_MODES.DIRECT_CHAT,
    retrievalMeta: retrievalResult.meta || {},
  };
}

module.exports = {
  AGENT_MODES,
  run,
};
