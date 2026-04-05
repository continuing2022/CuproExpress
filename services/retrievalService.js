const ragService = require("./ragService");
const searchTool = require("../searchTool");

const AGENT_MODES = {
  LOCAL_RAG: "local_rag",
  WEB_SEARCH: "web_search",
  DIRECT_CHAT: "direct_chat",
};

function resolveMode({ networkConfig }) {
  if (networkConfig?.search) return AGENT_MODES.WEB_SEARCH;
  return AGENT_MODES.LOCAL_RAG;
}

async function retrieve({ mode, query, history, options = {} }) {
  if (mode === AGENT_MODES.WEB_SEARCH) {
    return searchTool.retrieveContext({ query, history, options });
  }

  if (mode === AGENT_MODES.LOCAL_RAG) {
    const ragResult = await ragService.retrieveContext({ query, history, options });
    if (ragResult.contextText) return ragResult;
    return {
      mode: AGENT_MODES.DIRECT_CHAT,
      contextText: "",
      meta: { fallbackFrom: AGENT_MODES.LOCAL_RAG, reason: "empty_context" },
    };
  }

  return {
    mode: AGENT_MODES.DIRECT_CHAT,
    contextText: "",
    meta: {},
  };
}

module.exports = {
  AGENT_MODES,
  resolveMode,
  retrieve,
};
