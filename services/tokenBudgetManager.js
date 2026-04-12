const { getModelMetadata } = require("./modelRegistry");
const {
  estimateMessagesTokens,
  estimateTextTokens,
  trimMessagesToTokenBudget,
  trimTextToTokenBudget,
} = require("./messageTokenEstimator");

function buildBudgetProfile(modelName) {
  const metadata = getModelMetadata(modelName);
  const contextWindow = metadata.contextWindow;
  const reservedOutputTokens = Math.max(
    2000,
    Math.min(
      Math.floor(contextWindow * 0.2),
      metadata.preferredOutputTokens || 4000,
    ),
  );
  const inputBudgetTokens = Math.max(
    4096,
    Math.floor(Math.min(contextWindow * 0.8, contextWindow - reservedOutputTokens)),
  );

  const summaryBudgetTokens = clampByInputBudget(inputBudgetTokens, 1000, 0.08);
  const recentBudgetTokens = clampByInputBudget(inputBudgetTokens, 3000, 0.28, 1500);
  const memoryBudgetTokens = clampByInputBudget(inputBudgetTokens, 1200, 0.1, 800);
  const retrievalBudgetTokens = clampByInputBudget(inputBudgetTokens, 2000, 0.16, 1200);

  return {
    modelName,
    contextWindow,
    reservedOutputTokens,
    inputBudgetTokens,
    summaryBudgetTokens,
    recentBudgetTokens,
    memoryBudgetTokens,
    retrievalBudgetTokens,
  };
}

function applyTokenBudget({
  modelName,
  systemPrompt = "",
  conversationSummary = "",
  recentMessages = [],
  recalledMemories = [],
  retrievalContext = "",
  currentUserMessage = "",
}) {
  const budget = buildBudgetProfile(modelName);

  const summaryText = trimTextToTokenBudget(
    conversationSummary,
    budget.summaryBudgetTokens,
  );
  let trimmedRecentMessages = trimMessagesToTokenBudget(
    recentMessages,
    budget.recentBudgetTokens,
  );
  let trimmedMemories = trimMemoryItems(
    recalledMemories,
    budget.memoryBudgetTokens,
  );
  let trimmedRetrievalContext = trimTextToTokenBudget(
    retrievalContext,
    budget.retrievalBudgetTokens,
  );

  const diagnostics = {
    budget,
    summaryUsed: Boolean(summaryText.trim()),
    truncated: false,
    truncationSteps: [],
  };

  let totalEstimate = estimateTotalInputTokens({
    systemPrompt,
    summaryText,
    recentMessages: trimmedRecentMessages,
    recalledMemories: trimmedMemories,
    retrievalContext: trimmedRetrievalContext,
    currentUserMessage,
  });

  if (totalEstimate > budget.inputBudgetTokens && trimmedMemories.length > 0) {
    diagnostics.truncated = true;
    diagnostics.truncationSteps.push("recalled_memories");
    trimmedMemories = shrinkMemoryItemsToFit({
      items: trimmedMemories,
      systemPrompt,
      summaryText,
      recentMessages: trimmedRecentMessages,
      retrievalContext: trimmedRetrievalContext,
      currentUserMessage,
      inputBudgetTokens: budget.inputBudgetTokens,
    });
    totalEstimate = estimateTotalInputTokens({
      systemPrompt,
      summaryText,
      recentMessages: trimmedRecentMessages,
      recalledMemories: trimmedMemories,
      retrievalContext: trimmedRetrievalContext,
      currentUserMessage,
    });
  }

  if (totalEstimate > budget.inputBudgetTokens && trimmedRecentMessages.length > 0) {
    diagnostics.truncated = true;
    diagnostics.truncationSteps.push("recent_messages");
    trimmedRecentMessages = shrinkMessagesToFit({
      messages: trimmedRecentMessages,
      systemPrompt,
      summaryText,
      recalledMemories: trimmedMemories,
      retrievalContext: trimmedRetrievalContext,
      currentUserMessage,
      inputBudgetTokens: budget.inputBudgetTokens,
    });
    totalEstimate = estimateTotalInputTokens({
      systemPrompt,
      summaryText,
      recentMessages: trimmedRecentMessages,
      recalledMemories: trimmedMemories,
      retrievalContext: trimmedRetrievalContext,
      currentUserMessage,
    });
  }

  if (totalEstimate > budget.inputBudgetTokens && trimmedRetrievalContext) {
    diagnostics.truncated = true;
    diagnostics.truncationSteps.push("retrieval_context");
    const remaining =
      budget.inputBudgetTokens -
      estimateTotalInputTokens({
        systemPrompt,
        summaryText,
        recentMessages: trimmedRecentMessages,
        recalledMemories: trimmedMemories,
        retrievalContext: "",
        currentUserMessage,
      });
    trimmedRetrievalContext = trimTextToTokenBudget(
      trimmedRetrievalContext,
      Math.max(128, remaining),
    );
    totalEstimate = estimateTotalInputTokens({
      systemPrompt,
      summaryText,
      recentMessages: trimmedRecentMessages,
      recalledMemories: trimmedMemories,
      retrievalContext: trimmedRetrievalContext,
      currentUserMessage,
    });
  }

  diagnostics.estimatedInputTokens = totalEstimate;
  diagnostics.recentMessageCount = trimmedRecentMessages.length;
  diagnostics.memoryRecallCount = trimmedMemories.length;
  diagnostics.ragContextTokens = estimateTextTokens(trimmedRetrievalContext);

  return {
    summaryText,
    recentMessages: trimmedRecentMessages,
    recalledMemories: trimmedMemories,
    retrievalContext: trimmedRetrievalContext,
    diagnostics,
  };
}

function estimateTotalInputTokens({
  systemPrompt = "",
  summaryText = "",
  recentMessages = [],
  recalledMemories = [],
  retrievalContext = "",
  currentUserMessage = "",
}) {
  return (
    estimateTextTokens(systemPrompt) +
    estimateTextTokens(summaryText) +
    estimateMessagesTokens(recentMessages) +
    estimateTextTokens(formatMemoryItems(recalledMemories)) +
    estimateTextTokens(retrievalContext) +
    estimateTextTokens(currentUserMessage)
  );
}

function trimMemoryItems(items = [], maxTokens = 0) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!maxTokens) return [...items];

  const kept = [];
  let total = 0;
  for (const item of items) {
    const next = estimateTextTokens(item.content || "");
    if (kept.length > 0 && total + next > maxTokens) break;
    if (kept.length === 0 && next > maxTokens) {
      kept.push({
        ...item,
        content: trimTextToTokenBudget(item.content || "", maxTokens),
      });
      break;
    }
    kept.push(item);
    total += next;
  }
  return kept;
}

function shrinkMemoryItemsToFit({
  items,
  systemPrompt,
  summaryText,
  recentMessages,
  retrievalContext,
  currentUserMessage,
  inputBudgetTokens,
}) {
  const kept = [...items];
  while (
    kept.length > 0 &&
    estimateTotalInputTokens({
      systemPrompt,
      summaryText,
      recentMessages,
      recalledMemories: kept,
      retrievalContext,
      currentUserMessage,
    }) > inputBudgetTokens
  ) {
    kept.pop();
  }
  return kept;
}

function shrinkMessagesToFit({
  messages,
  systemPrompt,
  summaryText,
  recalledMemories,
  retrievalContext,
  currentUserMessage,
  inputBudgetTokens,
}) {
  const kept = [...messages];
  while (
    kept.length > 1 &&
    estimateTotalInputTokens({
      systemPrompt,
      summaryText,
      recentMessages: kept,
      recalledMemories,
      retrievalContext,
      currentUserMessage,
    }) > inputBudgetTokens
  ) {
    kept.shift();
  }
  return kept;
}

function formatMemoryItems(items = []) {
  return (items || [])
    .map((item, index) => `${index + 1}. [${item.memory_type || "general"}] ${item.content || ""}`)
    .join("\n");
}

function clampByInputBudget(inputBudgetTokens, preferred, ratio, minimum = 0) {
  return Math.max(minimum, Math.min(preferred, Math.floor(inputBudgetTokens * ratio)));
}

module.exports = {
  buildBudgetProfile,
  applyTokenBudget,
  estimateTotalInputTokens,
  formatMemoryItems,
};
