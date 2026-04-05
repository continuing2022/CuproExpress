const { getClientForModel } = require("./modelRegistry");

const SYSTEM_PROMPT = `
你是 CuproAgent 的企业助手。

回答要求：
- 优先给出直接结论，再补充关键依据。
- 如果上下文不足，要明确说明不确定点。
- 使用检索内容时，不要把未出现的信息编造成事实。
- 语言尽量清晰、专业、可执行。
`.trim();

async function getChatCompletionStream(messages, onChunk, options = {}) {
  try {
    const modelName = options.model || "qwen-plus";
    const { client, model } = getClientForModel(modelName);
    const hasSystem = Array.isArray(messages)
      ? messages.some((item) => item.role === "system")
      : false;

    const finalMessages = hasSystem
      ? messages
      : [{ role: "system", content: SYSTEM_PROMPT }, ...(messages || [])];

    const stream = await client.chat.completions.create({
      model,
      messages: finalMessages,
      temperature: 1,
      max_tokens: options.max_tokens || 2000,
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (!content) continue;
      fullContent += content;
      onChunk(content);
    }

    return fullContent;
  } catch (error) {
    console.error(
      `getChatCompletionStream failed for model ${options.model || "qwen-plus"}:`,
      error?.message || error,
    );
    throw error;
  }
}

module.exports = {
  SYSTEM_PROMPT,
  getChatCompletionStream,
};
