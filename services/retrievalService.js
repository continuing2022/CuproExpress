const ragService = require("./ragService");
const searchTool = require("../searchTool");

const AGENT_MODES = {
  LOCAL_RAG: "local_rag",
  WEB_SEARCH: "web_search",
  DIRECT_CHAT: "direct_chat",
};
// 检索模式
function resolveMode({ networkConfig }) {
  // 显式开启联网检索时，优先走 web_search。
  if (networkConfig?.search) return AGENT_MODES.WEB_SEARCH;
  // 默认走本地检索，优先利用私有知识库。
  return AGENT_MODES.LOCAL_RAG;
}
// 根据不同的检索模式调用对应的服务来获取上下文信息
async function retrieve({ mode, query, history, options = {} }) {
  if (mode === AGENT_MODES.WEB_SEARCH) {
    return searchTool.retrieveContext({ query, history, options });
  }

  if (mode === AGENT_MODES.LOCAL_RAG) {
    const ragResult = await ragService.retrieveContext({
      query,
      history,
      options,
    });
    if (ragResult.contextText) return ragResult;
    // 回退策略：检索为空时不阻断生成，改走 direct_chat。
    return {
      mode: AGENT_MODES.DIRECT_CHAT,
      contextText: "",
      meta: { fallbackFrom: AGENT_MODES.LOCAL_RAG, reason: "empty_context" },
    };
  }

  // 防御性兜底：未知模式统一降级为 direct_chat。
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
