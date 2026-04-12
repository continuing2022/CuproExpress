function buildMemoryChunks(conversationId, messages = [], chunkSize = 4) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const chunks = [];
  for (let index = 0; index < messages.length; index += chunkSize) {
    const slice = messages.slice(index, index + chunkSize);
    const content = slice
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n");

    chunks.push({
      conversationId,
      sourceMessageStartId: slice[0].message_id,
      sourceMessageEndId: slice[slice.length - 1].message_id,
      content,
      memoryType: classifyMemoryType(content),
      keywords: extractKeywords(content),
    });
  }

  return chunks;
}

function classifyMemoryType(content = "") {
  const normalized = String(content || "").toLowerCase();
  if (
    /(喜欢|偏好|习惯|最好|不要|必须|约束|preference|prefer|should not|must)/i.test(
      normalized,
    )
  ) {
    return "preference";
  }
  if (/(任务|计划|待办|todo|next|follow up|action)/i.test(normalized)) {
    return "task";
  }
  if (/(是|为|fact|背景|账号|地址|联系人|预算|deadline|日期)/i.test(normalized)) {
    return "fact";
  }
  return "general";
}

function extractKeywords(input = "") {
  const text = String(input || "").toLowerCase();
  const englishTerms = text.match(/[a-z0-9]{2,}/g) || [];
  const cjkTerms = [];
  const chineseSegments = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]{2,}/g) || [];
  for (const segment of chineseSegments) {
    if (segment.length <= 2) {
      cjkTerms.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      cjkTerms.push(segment.slice(index, index + 2));
    }
  }

  return Array.from(new Set([...englishTerms, ...cjkTerms])).slice(0, 64);
}

module.exports = {
  buildMemoryChunks,
  classifyMemoryType,
  extractKeywords,
};
