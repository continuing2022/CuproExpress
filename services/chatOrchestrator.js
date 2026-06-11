const langchainAgentRunner = require("./langchainAgentRunner");
const { estimateTextTokens } = require("./messageTokenEstimator");
const { SYSTEM_PROMPT } = require("./openai");

async function run({
  conversationId,
  content,
  model,
  networkConfig,
  pendingMessageId,
  observer,
  onRetrieved,
  onChunk,
}) {
  const startedAt = Date.now();

  try {
    const result = await langchainAgentRunner.run({
      conversationId,
      content,
      model,
      networkConfig,
      pendingMessageId,
      observer,
      onRetrieved,
      onChunk,
    });

    const telemetry = buildTelemetry({
      conversationId,
      model,
      diagnostics: result.diagnostics,
      usage: result.usage,
      responseContent: result.fullResponse,
      latencyMs: Date.now() - startedAt,
    });
    logTelemetry(telemetry);

    return {
      fullResponse: result.fullResponse,
      mode: result.mode || "direct_chat",
      retrievalMeta: result.retrievalMeta || {},
      diagnostics: result.diagnostics || {},
      telemetry,
    };
  } catch (error) {
    console.error("langchain agent run failed:", error);
    throw error;
  }
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
