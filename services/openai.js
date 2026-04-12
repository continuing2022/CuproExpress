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
    // 调用createStreamingCompletion函数创建一个流式聊天完成请求，
    // 传递最终的消息列表、onChunk回调函数以及一些选项参数，如温度和最大token数等。
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
// 这个模块负责协调聊天的整体流程，包括构建上下文、调用OpenAI服务、处理流式响应以及记录相关的遥测数据。
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
// 这个函数负责构建发送给OpenAI模型的上下文，
// 包括系统提示、对话摘要、近期消息、召回的记忆和外部检索上下文等内容，并根据模型的token限制进行预算管理。
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
