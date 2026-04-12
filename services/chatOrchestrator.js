const openaiService = require("./openai");
const { buildContext, buildModelMessages } = require("./contextAssembler");
const { estimateTextTokens } = require("./messageTokenEstimator");
// 这个模块负责协调聊天的整体流程，包括构建上下文、调用OpenAI服务、处理流式响应以及记录相关的遥测数据。
async function run({
  conversationId,
  content,
  model,
  networkConfig,
  pendingMessageId,
  onRetrieved,
  onChunk,
}) {
  const startedAt = Date.now();
  const context = await buildContext({
    conversationId,
    content,
    model,
    networkConfig,
    pendingMessageId,
  });
  // 如果提供了onRetrieved回调函数，则在检索结果准备好后调用它，传递检索模式、元信息和诊断数据等相关信息。
  if (typeof onRetrieved === "function") {
    onRetrieved({
      mode: context.retrievalResult.mode,
      meta: context.retrievalResult.meta || {},
      diagnostics: context.diagnostics,
    });
  }
  // 根据构建的上下文生成最终要发送给OpenAI模型的消息列表
  const finalMessages = buildModelMessages(context);
  const completion = await openaiService.getChatCompletionStream(
    finalMessages,
    onChunk, // 将onChunk回调函数传递给OpenAI服务，以便在接收到每个流式响应块时调用它。
    { max_tokens: 2000, model },
  );

  const telemetry = buildTelemetry({
    conversationId,
    model,
    diagnostics: context.diagnostics,
    usage: completion.usage,
    responseContent: completion.content,
    latencyMs: Date.now() - startedAt,
  });
  logTelemetry(telemetry);

  return {
    fullResponse: completion.content,
    mode: context.retrievalResult.mode,
    retrievalMeta: context.retrievalResult.meta || {},
    diagnostics: context.diagnostics,
    telemetry,
  };
}

function buildTelemetry({
  conversationId,
  model,
  diagnostics = {},
  usage,
  responseContent = "",
  latencyMs,
}) {
  return {
    conversation_id: conversationId,
    model,
    estimated_input_tokens: diagnostics.estimatedInputTokens || 0,
    actual_prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens:
      usage?.completion_tokens ?? estimateTextTokens(responseContent || ""),
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    summary_used: diagnostics.summaryUsed || false,
    summary_refreshed: diagnostics.summaryRefreshed || false,
    recent_message_count: diagnostics.recentMessageCount || 0,
    memory_recall_count: diagnostics.memoryRecallCount || 0,
    rag_context_tokens: diagnostics.ragContextTokens || 0,
    truncated: diagnostics.truncated || false,
    latency_ms: latencyMs,
  };
}

function logTelemetry(telemetry) {
  console.info("[chat_telemetry]", JSON.stringify(telemetry));
}

module.exports = {
  run,
};
