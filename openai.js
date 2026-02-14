const OpenAI = require("openai");

// 初始化 OpenAI 客户端，配置为阿里云百炼的兼容模式
const openai = new OpenAI({
  apiKey: "sk-f65de29228b04076bb062ae6c4153f58", // 替换为你自己的 API Key
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // 阿里云百炼兼容模式地址
});

/**
 * 流式调用阿里云百炼 API
 * @param {Array} messages - 消息历史
 * @param {Function} onChunk - 接收每个chunk的回调函数
 * @param {Object} options - 可选配置
 */
async function getChatCompletionStream(messages, onChunk, options = {}) {
  try {
    const stream = await openai.chat.completions.create({
      model: options.model || "qwen-plus",
      messages: messages,
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
