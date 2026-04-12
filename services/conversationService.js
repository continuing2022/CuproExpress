const { conversationRepo } = require("../repositories");
const { buildContext } = require("./contextAssembler");
const {
  getConversationState,
  refreshConversationSummary,
  maybeRefreshConversationSummary,
} = require("./conversationSummaryService");
const {
  recallConversationMemories,
} = require("./conversationMemoryService");
// conversationService.js - 处理对话相关的业务逻辑
// 确保对话存在，如果不存在则创建新对话
async function ensureConversation({ userId, conversationId, title, content }) {
  if (conversationId) {
    const ownership = await conversationRepo.assertConversationOwner(
      userId,
      conversationId,
    );
    return {
      ...ownership,
      conversation: ownership.conversation,
      conversationId,
      created: false,
    };
  }

  const autoTitle =
    title || (content.length > 60 ? content.slice(0, 60) : content);
  const conversation = await conversationRepo.createConversation(
    userId,
    autoTitle,
  );
  return {
    ok: true,
    conversation,
    conversationId: conversation.conversation_id,
    created: true,
  };
}
// 添加用户消息到对话
async function addUserMessage(conversationId, content) {
  return conversationRepo.addMessage(conversationId, "user", content);
}
// 添加助手消息到对话
async function addAssistantMessage(conversationId, content) {
  return conversationRepo.addMessage(conversationId, "assistant", content);
}
// 获取对话历史消息，默认返回最近10条消息
async function getHistory(conversationId, limit = 10) {
  return conversationRepo.getMessages(conversationId, limit);
}

module.exports = {
  ensureConversation,
  addUserMessage,
  addAssistantMessage,
  getHistory,
  getConversationState,
  refreshConversationSummary,
  maybeRefreshConversationSummary,
  recallConversationMemories,
  buildContext,
};
