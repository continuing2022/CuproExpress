const { getClientForModel } = require("./modelRegistry");

const SYSTEM_PROMPT = `
You are CuproAgent, an enterprise AI assistant.
Response requirements:
- Provide the direct conclusion first, then key evidence.
- If context is insufficient, explicitly state uncertainty.
- Do not fabricate facts that are not supported by retrieved context.
- Keep language clear, professional, and actionable.
`.trim();

function buildFinalMessages(messages = []) {
  const normalized = Array.isArray(messages) ? messages : [];
  const hasSystem = normalized.some((item) => item?.role === "system");
  if (hasSystem) return normalized;
  return [{ role: "system", content: SYSTEM_PROMPT }, ...normalized];
}

function emitChunk(onChunk, content) {
  if (typeof onChunk === "function") {
    onChunk(content);
  }
}

async function getChatCompletionStream(messages, onChunk, options = {}) {
  try {
    const modelName = options.model || "qwen-plus";
    const { client, model } = getClientForModel(modelName);

    const stream = await createStreamingCompletion(client, {
      model,
      messages: buildFinalMessages(messages),
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
      const content = chunk?.choices?.[0]?.delta?.content || "";
      if (!content) continue;
      fullContent += content;
      emitChunk(onChunk, content);
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

    const completion = await client.chat.completions.create({
      model,
      messages: buildFinalMessages(messages),
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
