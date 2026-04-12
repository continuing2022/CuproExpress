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

    const stream = await createStreamingCompletion(client, {
      model,
      messages: finalMessages,
      temperature: options.temperature ?? 1,
      max_tokens: options.max_tokens || 2000,
      stream: true,
    });

    let fullContent = "";
    let usage = null;
    for await (const chunk of stream) {
      if (chunk?.usage) {
        usage = chunk.usage;
      }
      const content = chunk.choices[0]?.delta?.content || "";
      if (!content) continue;
      fullContent += content;
      onChunk(content);
    }

    return {
      content: fullContent,
      usage,
    };
  } catch (error) {
    console.error(
      `getChatCompletionStream failed for model ${options.model || "qwen-plus"}:`,
      error?.message || error,
    );
    throw error;
  }
}

async function getChatCompletion(messages, options = {}) {
  try {
    const modelName = options.model || "qwen-plus";
    const { client, model } = getClientForModel(modelName);
    const hasSystem = Array.isArray(messages)
      ? messages.some((item) => item.role === "system")
      : false;
    const finalMessages = hasSystem
      ? messages
      : [{ role: "system", content: SYSTEM_PROMPT }, ...(messages || [])];

    const completion = await client.chat.completions.create({
      model,
      messages: finalMessages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens || 1200,
      stream: false,
    });

    return {
      content: completion.choices?.[0]?.message?.content || "",
      usage: completion.usage || null,
    };
  } catch (error) {
    console.error(
      `getChatCompletion failed for model ${options.model || "qwen-plus"}:`,
      error?.message || error,
    );
    throw error;
  }
}

async function createStreamingCompletion(client, payload) {
  try {
    return await client.chat.completions.create({
      ...payload,
      stream_options: { include_usage: true },
    });
  } catch (error) {
    const message = String(error?.message || "");
    const shouldRetryWithoutUsage =
      message.includes("stream_options") ||
      message.includes("include_usage") ||
      message.includes("unknown parameter");

    if (!shouldRetryWithoutUsage) {
      throw error;
    }

    return client.chat.completions.create(payload);
  }
}

module.exports = {
  SYSTEM_PROMPT,
  getChatCompletionStream,
  getChatCompletion,
};
