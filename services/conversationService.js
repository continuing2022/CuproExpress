const { conversationRepo } = require("../repositories");

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

async function ensureConversation({ userId, conversationId, title, content }) {
  const normalizedContent = normalizeText(content);
  const normalizedTitle = normalizeText(title);

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
    normalizedTitle ||
    (normalizedContent.length > 60
      ? normalizedContent.slice(0, 60)
      : normalizedContent) || "附件对话";
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

async function addUserMessage(conversationId, content) {
  return conversationRepo.addMessage(conversationId, "user", String(content || ""));
}

async function addAssistantMessage(conversationId, content, options) {
  return conversationRepo.addMessage(conversationId, "assistant", String(content || ""), options);
}

async function getHistory(conversationId, limit = 10) {
  return conversationRepo.getMessages(conversationId, limit);
}

module.exports = {
  ensureConversation,
  addUserMessage,
  addAssistantMessage,
  updateAssistantMessage: (...args) => conversationRepo.updateAssistantMessage(...args),
  getHistory,
};
