const { conversationRepo, conversationStateRepo } = require("../repositories");
const openaiService = require("./openai");
const { getModelMetadata } = require("./modelRegistry");
const {
  estimateMessagesTokens,
  estimateTextTokens,
  trimTextToTokenBudget,
} = require("./messageTokenEstimator");
const { buildBudgetProfile } = require("./tokenBudgetManager");
const { persistMemoryChunks } = require("./conversationMemoryService");
// 这个模块负责管理会话摘要的生成和更新，包括判断何时需要刷新摘要、
// 调用OpenAI模型进行摘要生成、处理摘要结果以及维护会话状态等功能。
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "qwen-plus";
const SUMMARY_BATCH_SIZE = Number(process.env.SUMMARY_BATCH_SIZE || 24);
const SUMMARY_TRIGGER_COUNT = Number(process.env.SUMMARY_TRIGGER_COUNT || 12);
const summaryLocks = new Map();
// 获取会话状态，如果不存在则创建一个新的状态记录
async function getConversationState(conversationId) {
  return conversationStateRepo.ensureConversationState(conversationId);
}
// 尝试刷新会话摘要，首先获取当前的会话状态和未被摘要覆盖的消息数量，
// 然后根据预设的触发条件判断是否需要刷新摘要，如果需要则分批处理未摘要的消息，
// 调用OpenAI模型生成新的摘要，并更新会话状态记录。
async function maybeRefreshConversationSummary({
  conversationId,
  model,
  beforeMessageId,
  force = false,
}) {
  return withConversationSummaryLock(conversationId, async () => {
    const state = await getConversationState(conversationId);
    const unsummarizedCount = await conversationRepo.countMessagesAfter(
      conversationId,
      state.last_summarized_message_id,
      { beforeMessageId },
    );

    const budget = buildBudgetProfile(model);
    const unsummarizedMessages = await conversationRepo.getMessagesAfter(
      conversationId,
      state.last_summarized_message_id,
      {
        beforeMessageId,
        limit: SUMMARY_BATCH_SIZE,
      },
    );
    const currentLoadEstimate =
      estimateTextTokens(state.running_summary || "") +
      estimateMessagesTokens(unsummarizedMessages);

    const shouldRefresh =
      force ||
      unsummarizedCount >= SUMMARY_TRIGGER_COUNT ||
      currentLoadEstimate >= Math.floor(budget.inputBudgetTokens * 0.7);

    if (!shouldRefresh) {
      return {
        refreshed: false,
        state,
        unsummarizedCount,
      };
    }

    let latestState = state;
    let remainingCount = unsummarizedCount;
    let refreshed = false;
    let loopCount = 0;

    while (
      remainingCount > 0 &&
      (force || remainingCount >= SUMMARY_TRIGGER_COUNT || loopCount === 0) &&
      loopCount < 5
    ) {
      const batch = await conversationRepo.getMessagesAfter(
        conversationId,
        latestState.last_summarized_message_id,
        {
          beforeMessageId,
          limit: SUMMARY_BATCH_SIZE,
        },
      );
      if (batch.length === 0) break;

      const summarized = await summarizeBatch(latestState, batch);
      latestState = await conversationStateRepo.upsertConversationState({
        conversationId,
        runningSummary: summarized.runningSummary,
        summaryVersion: (latestState.summary_version || 0) + 1,
        lastSummarizedMessageId: batch[batch.length - 1].message_id,
        memoryFacts: summarized.memoryFacts,
      });
      await persistMemoryChunks(conversationId, batch);

      refreshed = true;
      loopCount += 1;
      remainingCount = await conversationRepo.countMessagesAfter(
        conversationId,
        latestState.last_summarized_message_id,
        { beforeMessageId },
      );
    }

    return {
      refreshed,
      state: latestState,
      unsummarizedCount: remainingCount,
    };
  });
}

async function refreshConversationSummary(options) {
  return maybeRefreshConversationSummary({
    ...options,
    force: true,
  });
}

async function summarizeBatch(state, messages) {
  const previousSummary = state.running_summary || "";
  const previousFacts = Array.isArray(state.memory_facts_json)
    ? state.memory_facts_json
    : [];
  const messageText = formatMessagesForSummary(messages);

  try {
    const completion = await openaiService.getChatCompletion(
      [
        {
          role: "system",
          content:
            "你是会话记忆压缩器。请把旧摘要与新增消息合并为稳定的结构化摘要，只返回 JSON，不要输出解释文字。",
        },
        {
          role: "user",
          content: [
            "请基于以下信息生成新的会话摘要。",
            "要求：",
            "1. 只输出一个 JSON 对象。",
            "2. JSON 必须包含字段 running_summary 和 memory_facts。",
            "3. running_summary 用中文，固定包含以下段落标题：",
            "task_progress",
            "confirmed_facts",
            "user_preferences",
            "open_questions",
            "pending_actions",
            "4. memory_facts 返回字符串数组，保留长期有效的事实、偏好、约束。",
            "",
            `旧摘要：\n${previousSummary || "(空)"}`,
            "",
            `已有 memory_facts：\n${JSON.stringify(previousFacts, null, 2)}`,
            "",
            `新增消息：\n${messageText}`,
          ].join("\n"),
        },
      ],
      {
        model: SUMMARY_MODEL,
        temperature: 0.1,
        max_tokens: Math.min(
          1400,
          Math.max(
            800,
            Math.floor(
              getModelMetadata(SUMMARY_MODEL).preferredOutputTokens / 2,
            ),
          ),
        ),
      },
    );

    const parsed = extractJsonObject(completion.content);
    const runningSummary = normalizeStructuredSummary(parsed?.running_summary);
    const memoryFacts = normalizeMemoryFacts(
      parsed?.memory_facts,
      previousFacts,
    );

    return {
      runningSummary:
        runningSummary || fallbackSummary(previousSummary, messages),
      memoryFacts,
      usage: completion.usage || null,
    };
  } catch (error) {
    return {
      runningSummary: fallbackSummary(previousSummary, messages),
      memoryFacts: previousFacts,
      usage: null,
    };
  }
}

function formatMessagesForSummary(messages = []) {
  return (messages || [])
    .map(
      (message) =>
        `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`,
    )
    .join("\n");
}

function normalizeStructuredSummary(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const sections = [
    "task_progress",
    "confirmed_facts",
    "user_preferences",
    "open_questions",
    "pending_actions",
  ];
  const present = sections.every((section) => raw.includes(section));
  if (present) {
    return raw;
  }

  return [
    "task_progress",
    raw,
    "",
    "confirmed_facts",
    "",
    "",
    "user_preferences",
    "",
    "",
    "open_questions",
    "",
    "",
    "pending_actions",
    "",
  ].join("\n");
}

function normalizeMemoryFacts(nextFacts, previousFacts = []) {
  const merged = [];
  for (const item of [
    ...(Array.isArray(nextFacts) ? nextFacts : []),
    ...previousFacts,
  ]) {
    const text = String(item || "").trim();
    if (!text || merged.includes(text)) continue;
    merged.push(text);
    if (merged.length >= 20) break;
  }
  return merged;
}

function fallbackSummary(previousSummary, messages = []) {
  const excerpt = trimTextToTokenBudget(
    formatMessagesForSummary(messages),
    700,
  );
  const merged = [
    "task_progress",
    previousSummary || "(暂无)",
    "",
    "confirmed_facts",
    excerpt,
    "",
    "user_preferences",
    "",
    "",
    "open_questions",
    "",
    "",
    "pending_actions",
    "",
  ].join("\n");
  return trimTextToTokenBudget(merged, 1000);
}

function extractJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
}

async function withConversationSummaryLock(conversationId, task) {
  const previous = summaryLocks.get(conversationId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const currentChain = previous.then(() => current);
  summaryLocks.set(conversationId, currentChain);

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (summaryLocks.get(conversationId) === currentChain) {
      summaryLocks.delete(conversationId);
    }
  }
}

module.exports = {
  SUMMARY_MODEL,
  SUMMARY_BATCH_SIZE,
  SUMMARY_TRIGGER_COUNT,
  getConversationState,
  maybeRefreshConversationSummary,
  refreshConversationSummary,
};
