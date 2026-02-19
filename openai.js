const OpenAI = require("openai");

// 初始化 OpenAI 客户端，配置为阿里云百炼的兼容模式
const openai = new OpenAI({
  apiKey: "sk-f65de29228b04076bb062ae6c4153f58", // 替换为你自己的 API Key
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // 阿里云百炼兼容模式地址
});

// 固定专业 system prompt（铜及铜合金领域）
const SYSTEM_PROMPT = `
你是一名铜及铜合金材料领域的专家，擅长：

- 铜合金牌号分类
- 化学成分分析
- 力学性能对比
- 热处理工艺解释
- 应用场景推荐
- 成分与性能关系分析

回答要求：
1. 使用专业术语
2. 回答结构清晰
3. 尽量给出具体数据
4. 避免泛泛而谈
5. 如果问题超出铜及铜合金领域，请说明本系统仅支持铜及铜合金相关问题
`;

/**
 * 流式调用阿里云百炼 API
 * @param {Array} messages - 消息历史
 * @param {Function} onChunk - 接收每个chunk的回调函数
 * @param {Object} options - 可选配置
 */
async function getChatCompletionStream(messages, onChunk, options = {}) {
  try {
    // 若调用方没有提供 system 消息，则在首位注入固定的系统提示
    const messagesWithSystem = Array.isArray(messages)
      ? messages.some((m) => m.role === "system")
        ? messages
        : [{ role: "system", content: SYSTEM_PROMPT }, ...messages]
      : [{ role: "system", content: SYSTEM_PROMPT }];

    const stream = await openai.chat.completions.create({
      model: options.model || "qwen-plus",
      messages: messagesWithSystem,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2000,
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullContent += content;
        onChunk(content);
      }
    }

    return fullContent;
  } catch (error) {
    console.error("阿里云百炼 Stream API Error:", error);
    throw error;
  }
}

module.exports = {
  getChatCompletionStream,
};
