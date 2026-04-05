const { conversationRepo } = require("../repositories");

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
  const conversation = await conversationRepo.createConversation(userId, autoTitle);
  return {
    ok: true,
    conversation,
    conversationId: conversation.conversation_id,
    created: true,
  };
}

async function addUserMessage(conversationId, content) {
  return conversationRepo.addMessage(conversationId, "user", content);
}

async function addAssistantMessage(conversationId, content) {
  return conversationRepo.addMessage(conversationId, "assistant", content);
}

async function getHistory(conversationId, limit = 10) {
  return conversationRepo.getMessages(conversationId, limit);
}

module.exports = {
  ensureConversation,
  addUserMessage,
  addAssistantMessage,
  getHistory,
};
