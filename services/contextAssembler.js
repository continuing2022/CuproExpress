const { conversationRepo } = require("../repositories");
const { retrieve, resolveMode, AGENT_MODES } = require("./retrievalService");
const {
  maybeRefreshConversationSummary,
  getConversationState,
} = require("./conversationSummaryService");
const { recallConversationMemories } = require("./conversationMemoryService");
const { applyTokenBudget, formatMemoryItems } = require("./tokenBudgetManager");
const { SYSTEM_PROMPT } = require("./openai");
// 这个模块负责构建发送给OpenAI模型的上下文，
// 包括系统提示、对话摘要、近期消息、召回的记忆和外部检索上下文等内容，并根据模型的token限制进行预算管理。
async function buildContext({
  conversationId,
  content,
  model,
  networkConfig,
  pendingMessageId,
}) {
  const refreshResult = await maybeRefreshConversationSummary({
    conversationId,
    model,
    beforeMessageId: pendingMessageId,
  });
  const state =
    refreshResult.state || (await getConversationState(conversationId));

  const recentMessages = await conversationRepo.getMessagesAfter(
    conversationId,
    state.last_summarized_message_id || 0,
    { beforeMessageId: pendingMessageId },
  );
  const recalledMemories = await recallConversationMemories({
    conversationId,
    query: content,
    topK: 3,
    beforeMessageId: pendingMessageId,
  });

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
        history: recentMessages,
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

  const budgeted = applyTokenBudget({
    modelName: model,
    systemPrompt: SYSTEM_PROMPT,
    conversationSummary: state.running_summary || "",
    recentMessages,
    recalledMemories,
    retrievalContext: retrievalResult.contextText || "",
    currentUserMessage: content,
  });

  return {
    systemPrompt: SYSTEM_PROMPT,
    conversationSummary: budgeted.summaryText,
    recentMessages: budgeted.recentMessages,
    recalledMemories: budgeted.recalledMemories,
    retrievalContext: budgeted.retrievalContext,
    currentUserMessage: content,
    diagnostics: {
      ...budgeted.diagnostics,
      summaryRefreshed: Boolean(refreshResult.refreshed),
      contextProfile: {
        recent_count: budgeted.diagnostics.recentMessageCount,
        summary_used: budgeted.diagnostics.summaryUsed,
        memory_hits: budgeted.diagnostics.memoryRecallCount,
        truncated: budgeted.diagnostics.truncated,
      },
    },
    retrievalResult,
  };
}
function buildModelMessages(context) {
  const messages = [{ role: "system", content: context.systemPrompt }];

  if (context.conversationSummary) {
    messages.push({
      role: "system",
      content: `Conversation Summary\n${context.conversationSummary}`,
    });
  }

  if (
    Array.isArray(context.recalledMemories) &&
    context.recalledMemories.length > 0
  ) {
    messages.push({
      role: "system",
      content: `Recalled Memories\n${formatMemoryItems(context.recalledMemories)}`,
    });
  }

  if (context.retrievalContext) {
    messages.push({
      role: "system",
      content: `External Retrieval Context\n${context.retrievalContext}`,
    });
  }

  for (const message of context.recentMessages || []) {
    messages.push({
      role: message.role,
      content: message.content,
    });
  }

  messages.push({ role: "user", content: context.currentUserMessage });
  return messages;
}

module.exports = {
  buildContext,
  buildModelMessages,
};
