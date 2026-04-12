// 这个模块负责处理会话记忆的持久化和召回功能，
// 主要包括将对话消息分块存储为记忆碎片，以及根据用户查询从存储的记忆中召回相关内容。
const {
  conversationMemoryRepo,
  conversationStateRepo,
} = require("../repositories");
const {
  buildMemoryChunks,
  extractKeywords,
} = require("./conversationMemoryUtils");

async function persistMemoryChunks(conversationId, messages = []) {
  const chunks = buildMemoryChunks(conversationId, messages);
  if (chunks.length === 0) return [];
  await conversationMemoryRepo.createMemoryChunks(chunks);
  return chunks;
}

async function recallConversationMemories({
  conversationId,
  query,
  topK = 3,
  beforeMessageId,
}) {
  const state =
    await conversationStateRepo.ensureConversationState(conversationId);
  if (!state || !state.last_summarized_message_id) return [];

  const candidates = await conversationMemoryRepo.listMemoryChunks(
    conversationId,
    {
      beforeMessageId,
      maxSourceMessageId: state.last_summarized_message_id,
      limit: 200,
    },
  );
  if (candidates.length === 0) return [];

  const queryTerms = extractKeywords(query);
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreMemoryCandidate(candidate, queryTerms, query),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(10, Number(topK) || 3)));

  return scored.map((item) => ({
    memory_id: item.memory_id,
    memory_type: item.memory_type,
    content: item.content,
    source_message_start_id: item.source_message_start_id,
    source_message_end_id: item.source_message_end_id,
    score: item.score,
  }));
}

function scoreMemoryCandidate(candidate, queryTerms = [], rawQuery = "") {
  const keywords = Array.isArray(candidate.keywords_json)
    ? candidate.keywords_json
    : extractKeywords(candidate.content);
  const keywordSet = new Set(keywords);
  let score = 0;

  for (const term of queryTerms) {
    if (keywordSet.has(term)) score += term.length >= 4 ? 3 : 2;
    else if (candidate.content.toLowerCase().includes(term)) score += 1;
  }

  if (rawQuery && candidate.content.includes(rawQuery.trim())) {
    score += 6;
  }

  if (
    candidate.memory_type === "preference" ||
    candidate.memory_type === "fact"
  ) {
    score += 1;
  }

  return score;
}

module.exports = {
  buildMemoryChunks,
  persistMemoryChunks,
  recallConversationMemories,
  extractKeywords,
};
