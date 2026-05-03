const {
  createAgent,
  summarizationMiddleware,
  tool,
  AIMessage,
  AIMessageChunk,
  HumanMessage,
} = require("langchain");
const { MemorySaver } = require("@langchain/langgraph");
const { z } = require("zod");
const { conversationRepo, conversationStateRepo } = require("../repositories");
const {
  getLangChainModelForName,
  assertSupportedModel,
} = require("./modelRegistry");
const { SYSTEM_PROMPT } = require("./openai");
const ragService = require("./ragService");
const searchTool = require("../searchTool");
const {
  estimateMessagesTokens,
  estimateTextTokens,
} = require("./messageTokenEstimator");

const SUMMARY_PREFIX = "CONVERSATION_SUMMARY";
const DEFAULT_HISTORY_LIMIT = 100; // 历史消息最大条数
const DEFAULT_SUMMARY_TRIGGER_TOKENS = 6000; // 触发摘要的Token阈值
const DEFAULT_SUMMARY_KEEP_MESSAGES = 20; // 摘要后保留最新消息数
const TOOL_HISTORY_LIMIT = 8;
const DEFAULT_SUMMARY_PROMPT = `
Summarize the conversation in Chinese and keep exactly these section headers:
task_progress
confirmed_facts
user_preferences
open_questions
pending_actions

Use concise bullets under each section.
Conversation:
{messages}
`.trim();
const sharedCheckpointer = new MemorySaver();
// 自动压缩历史对话
function createSummaryMiddleware(
  summaryModelName,
  triggerTokens,
  keepMessages,
) {
  return summarizationMiddleware({
    model: getLangChainModelForName(summaryModelName, {
      temperature: 0.1,
      maxTokens: 1200,
    }),
    trigger: { tokens: triggerTokens },
    keep: { messages: keepMessages },
    summaryPrefix: SUMMARY_PREFIX,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  });
}
// 创建配置化的Agent实例
function createConfiguredAgent({
  modelName,
  summaryModelName,
  networkSearchEnabled,
  triggerTokens,
  keepMessages,
  tools = [],
}) {
  return createAgent({
    model: getLangChainModelForName(modelName, {
      temperature: 0.2,
      maxTokens: 2000,
      streaming: true,
    }),
    tools,
    checkpointer: sharedCheckpointer,
    systemPrompt: buildSystemPrompt({ networkSearchEnabled }),
    middleware: [
      createSummaryMiddleware(summaryModelName, triggerTokens, keepMessages),
    ],
  });
}

async function run({
  conversationId,
  content,
  model,
  networkConfig,
  pendingMessageId,
  onRetrieved,
  onChunk,
}) {
  const historyLimit = readIntEnv(
    "LANGCHAIN_HISTORY_LIMIT",
    DEFAULT_HISTORY_LIMIT,
    {
      min: 5,
      max: 20,
    },
  );
  const summaryTriggerTokens = readIntEnv(
    "LANGCHAIN_SUMMARY_TRIGGER_TOKENS",
    DEFAULT_SUMMARY_TRIGGER_TOKENS,
    { min: 1000, max: 12000 },
  );
  const summaryKeepMessages = readIntEnv(
    "LANGCHAIN_SUMMARY_KEEP_MESSAGES",
    DEFAULT_SUMMARY_KEEP_MESSAGES,
    { min: 4, max: 20 },
  );
  const runConfig = {
    configurable: {
      thread_id: String(conversationId),
    },
  };

  const state =
    await conversationStateRepo.ensureConversationState(conversationId);
  const persistedSummary = String(state?.running_summary || "").trim();
  const summaryModelName = resolveSummaryModelName(model);
  const networkSearchEnabled = Boolean(networkConfig?.search);
  // 创建种子agent
  const seedAgent = createConfiguredAgent({
    modelName: model,
    summaryModelName,
    networkSearchEnabled,
    triggerTokens: summaryTriggerTokens,
    keepMessages: summaryKeepMessages,
    tools: [],
  });
  // 恢复当前对话的记忆
  await ensureThreadSeeded({
    agent: seedAgent,
    runConfig,
    conversationId,
    pendingMessageId,
    persistedSummary,
    historyLimit,
  });
  // 线程的状态
  const threadStateBefore = await safeGetThreadState(seedAgent, runConfig);
  // 提取所有的消息
  const threadMessagesBefore = getStateMessages(threadStateBefore);
  // 构建给工具使用的历史
  const historyForTools = buildToolHistoryFromThreadMessages(
    threadMessagesBefore,
    TOOL_HISTORY_LIMIT,
  );
  // 消息的数量
  const recentMessageCount = historyForTools.length;
  const summaryUsed =
    Boolean(persistedSummary) || hasSummaryMessage(threadMessagesBefore);
  const summaryFromState = extractLatestSummaryMessage(threadMessagesBefore);

  const retrievalTracker = createRetrievalTracker({
    onRetrieved,
    summaryUsed,
    recentCount: recentMessageCount,
  });
  retrievalTracker.reportInitial();
  const tools = createRetrievalTools({
    historyForTools,
    networkSearchEnabled,
    retrievalTracker,
  });
  const runAgent = createConfiguredAgent({
    modelName: model,
    summaryModelName,
    networkSearchEnabled,
    triggerTokens: summaryTriggerTokens,
    keepMessages: summaryKeepMessages,
    tools,
  });

  let fullResponse = "";
  let latestState = null;
  let usage = null;

  const stream = await runAgent.stream(
    { messages: [{ role: "user", content }] },
    {
      ...runConfig,
      streamMode: ["messages", "values"],
    },
  );

  for await (const event of stream) {
    if (!Array.isArray(event) || event.length < 2) continue;
    const [mode, payload] = event;
    if (mode === "messages") {
      const [message, metadata] = Array.isArray(payload) ? payload : [];
      const chunk = extractAssistantChunk(message, metadata);
      if (chunk) {
        fullResponse += chunk;
        console.debug("assistant chunk:", chunk);
        onChunk(chunk);
      }

      const usageSnapshot = extractUsage(message);
      if (usageSnapshot) {
        usage = usageSnapshot;
      }
      continue;
    }

    if (mode === "values") {
      latestState = payload;
    }
  }

  if (!fullResponse) {
    const fallbackResponse = extractFinalAssistantText(
      latestState?.messages || [],
    );
    if (fallbackResponse) {
      fullResponse = fallbackResponse;
      if (typeof onChunk === "function") {
        onChunk(fallbackResponse);
      }
    }
  }

  if (!latestState) {
    latestState = await safeGetThreadState(runAgent, runConfig);
  }

  const summaryPayload = extractLatestSummaryMessage(
    latestState?.messages || latestState?.values?.messages || [],
  );
  const summaryText =
    summaryPayload?.summaryText || summaryFromState?.summaryText || "";
  const summaryRefreshed = await persistSummary({
    conversationId,
    pendingMessageId,
    currentState: state,
    summaryText,
  });
  const threadMessagesAfter = getStateMessages(latestState);
  const finalRecentCount = buildToolHistoryFromThreadMessages(
    threadMessagesAfter,
    TOOL_HISTORY_LIMIT,
  ).length;

  return {
    fullResponse,
    mode: retrievalTracker.mode,
    retrievalMeta: retrievalTracker.meta,
    usage,
    diagnostics: {
      estimatedInputTokens: estimateInputTokens({
        summary: summaryText || persistedSummary,
        messages: buildRecentRoleContentMessages(threadMessagesAfter),
      }),
      summaryUsed: summaryUsed || summaryRefreshed,
      summaryRefreshed,
      recentMessageCount: finalRecentCount,
      memoryRecallCount: 0,
      ragContextTokens: retrievalTracker.contextTokens,
      truncated: false,
      contextProfile: {
        recent_count: finalRecentCount,
        summary_used: summaryUsed || summaryRefreshed,
        memory_hits: 0,
        truncated: false,
      },
    },
  };
}

function createRetrievalTools({
  historyForTools,
  networkSearchEnabled,
  retrievalTracker,
}) {
  const localRagTool = tool(
    async ({ query }) => {
      const retrieval = await runLocalRagRetrieval({ query, historyForTools });
      retrievalTracker.capture(retrieval);
      return formatToolResult(retrieval);
    },
    {
      name: "local_rag_retrieve",
      description:
        "Retrieve relevant context from the local/private knowledge base for the current question.",
      schema: z.object({
        query: z.string().min(1).describe("The current user question"),
      }),
    },
  );

  if (!networkSearchEnabled) {
    return [localRagTool];
  }

  const webSearchTool = tool(
    async ({ query }) => {
      const retrieval = await runWebSearchRetrieval({ query, historyForTools });
      retrievalTracker.capture(retrieval);
      return formatToolResult(retrieval);
    },
    {
      name: "web_search_retrieve",
      description:
        "Search public web sources for up-to-date information related to the user question.",
      schema: z.object({
        query: z.string().min(1).describe("The current user question"),
      }),
    },
  );

  return [localRagTool, webSearchTool];
}

async function runLocalRagRetrieval({ query, historyForTools }) {
  try {
    const result = await ragService.retrieveContext({
      query,
      history: historyForTools,
      options: {},
    });
    return normalizeRetrievalResult(result, "local_rag");
  } catch (error) {
    return {
      mode: "direct_chat",
      contextText: "",
      meta: {
        fallbackFrom: "local_rag",
        reason: "retrieval_error",
        message: String(error?.message || error),
      },
    };
  }
}

async function runWebSearchRetrieval({ query, historyForTools }) {
  try {
    const result = await searchTool.retrieveContext({
      query,
      history: historyForTools,
      options: {},
    });
    return normalizeRetrievalResult(result, "web_search");
  } catch (error) {
    return {
      mode: "direct_chat",
      contextText: "",
      meta: {
        fallbackFrom: "web_search",
        reason: "retrieval_error",
        message: String(error?.message || error),
      },
    };
  }
}

function normalizeRetrievalResult(result, fallbackMode) {
  const mode = String(result?.mode || fallbackMode);
  const contextText = String(result?.contextText || "");
  const meta = isPlainObject(result?.meta) ? result.meta : {};

  if (!contextText.trim()) {
    return {
      mode: "direct_chat",
      contextText: "",
      meta: {
        ...meta,
        fallbackFrom: fallbackMode,
        reason: meta.reason || "empty_context",
      },
    };
  }

  return {
    mode,
    contextText,
    meta,
  };
}

function formatToolResult(retrieval) {
  return JSON.stringify(
    {
      mode: retrieval.mode,
      meta: retrieval.meta || {},
      context: retrieval.contextText || "",
    },
    null,
    2,
  );
}

function createRetrievalTracker({ onRetrieved, summaryUsed, recentCount }) {
  const contextProfile = {
    recent_count: recentCount,
    summary_used: summaryUsed,
    memory_hits: 0,
    truncated: false,
  };

  return {
    mode: "direct_chat",
    meta: {},
    contextTokens: 0,
    reportInitial() {
      if (typeof onRetrieved !== "function") return;
      onRetrieved({
        mode: this.mode,
        meta: this.meta,
        diagnostics: { contextProfile },
      });
    },
    capture(retrieval) {
      const mode = String(retrieval?.mode || "direct_chat");
      const meta = isPlainObject(retrieval?.meta) ? retrieval.meta : {};
      const contextText = String(retrieval?.contextText || "");
      if (contextText) {
        this.contextTokens += estimateTextTokens(contextText);
      }

      if (mode !== "direct_chat") {
        this.mode = mode;
      } else if (this.mode === "direct_chat") {
        this.mode = mode;
      }
      this.meta = meta;

      if (typeof onRetrieved === "function") {
        onRetrieved({
          mode,
          meta,
          diagnostics: {
            contextProfile,
          },
        });
      }
    },
  };
}

function buildSystemPrompt({ networkSearchEnabled }) {
  return [
    SYSTEM_PROMPT,
    "",
    "Tool usage rules:",
    "- Call `local_rag_retrieve` at least once before giving the final answer.",
    "- Use `local_rag_retrieve` when the answer needs factual/project context.",
    networkSearchEnabled
      ? "- `web_search_retrieve` is enabled. Use it for latest/public-web information when needed."
      : "- Web search is disabled in this request. Do not claim web browsing.",
    "- If tool context is empty, continue with available context and explicitly state uncertainty.",
    "- Do not expose raw tool JSON in the final answer.",
  ].join("\n");
}

function buildSummaryMessage(summaryText) {
  return new HumanMessage({
    content: `${SUMMARY_PREFIX}\n\n${summaryText}`,
    additional_kwargs: {
      lc_source: "summarization",
    },
  });
}

async function ensureThreadSeeded({
  agent,
  runConfig,
  conversationId,
  pendingMessageId,
  persistedSummary,
  historyLimit,
}) {
  const existingState = await safeGetThreadState(agent, runConfig);
  if (getStateMessages(existingState).length > 0) {
    return;
  }

  const hasPending = Number.isFinite(Number(pendingMessageId));
  const historicalMessages = hasPending
    ? await conversationRepo.getMessagesAfter(conversationId, 0, {
        beforeMessageId: Number(pendingMessageId),
        limit: historyLimit,
      })
    : await conversationRepo.getMessages(conversationId, historyLimit);

  const seedMessages = [];
  if (persistedSummary) {
    seedMessages.push(buildSummaryMessage(persistedSummary));
  }
  for (const message of historicalMessages) {
    seedMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  if (seedMessages.length === 0) {
    return;
  }

  await agent.updateState(runConfig, { messages: seedMessages });
}

async function persistSummary({
  conversationId,
  pendingMessageId,
  currentState,
  summaryText,
}) {
  const nextSummary = String(summaryText || "").trim();
  if (!nextSummary) return false;

  const previousSummary = String(currentState?.running_summary || "").trim();
  if (previousSummary === nextSummary) return false;

  await conversationStateRepo.upsertConversationState({
    conversationId,
    runningSummary: nextSummary,
    summaryVersion: (Number(currentState?.summary_version) || 0) + 1,
    lastSummarizedMessageId: Number.isFinite(Number(pendingMessageId))
      ? Number(pendingMessageId)
      : Number(currentState?.last_summarized_message_id) || 0,
    memoryFacts: Array.isArray(currentState?.memory_facts_json)
      ? currentState.memory_facts_json
      : [],
  });

  return true;
}

function extractLatestSummaryMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = normalizeMessageContent(message?.content).trim();
    if (!content) continue;

    const isSummaryMessage =
      message?.additional_kwargs?.lc_source === "summarization" ||
      content.startsWith(SUMMARY_PREFIX);

    if (!isSummaryMessage) continue;
    return {
      raw: content,
      summaryText: stripSummaryPrefix(content),
    };
  }

  return null;
}

function stripSummaryPrefix(content) {
  const pattern = new RegExp(`^${escapeRegExp(SUMMARY_PREFIX)}:?\\s*`, "i");
  return String(content || "")
    .replace(pattern, "")
    .trim();
}

function extractAssistantChunk(message, metadata) {
  if (typeof message === "string") return message;
  if (!isAssistantMessage(message)) return "";
  if (message?.additional_kwargs?.lc_source === "summarization") return "";

  const contentText = normalizeMessageContent(message?.content);
  if (contentText) return contentText;

  if (typeof message?.text === "string") {
    return message.text;
  }

  return normalizeMessageContent(message?.contentBlocks);
}

function extractFinalAssistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    const text = normalizeMessageContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

function isAssistantMessage(message) {
  if (!message) return false;
  if (AIMessage.isInstance(message) || AIMessageChunk.isInstance(message)) {
    return true;
  }

  const type = typeof message.getType === "function" ? message.getType() : "";
  if (String(type).toLowerCase().startsWith("ai")) return true;
  return message.role === "assistant";
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (!content) return "";

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        return normalizeContentItem(item);
      })
      .join("");
  }

  return normalizeContentItem(content);
}

function normalizeContentItem(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.delta === "string") return item.delta;

  // Some providers use "output_text" style blocks for incremental output.
  if (
    (item.type === "output_text" ||
      item.type === "text" ||
      item.type === "text_delta") &&
    typeof item.value === "string"
  ) {
    return item.value;
  }

  return "";
}

function extractUsage(message) {
  if (!isPlainObject(message)) return null;

  const usage =
    message.usage_metadata ||
    message.response_metadata?.usage_metadata ||
    message.response_metadata?.tokenUsage ||
    message.response_metadata?.usage;

  if (!isPlainObject(usage)) return null;

  const promptTokens = pickNumber([
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokens,
  ]);
  const completionTokens = pickNumber([
    usage.output_tokens,
    usage.completion_tokens,
    usage.completionTokens,
  ]);
  const cachedTokens = pickNumber([
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_token_details?.cache_read,
    usage?.input_tokens_details?.cached_tokens,
  ]);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    prompt_tokens_details: {
      cached_tokens: cachedTokens,
    },
  };
}

function estimateInputTokens({ summary, messages }) {
  const messageList = (messages || []).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  if (summary) {
    messageList.unshift({
      role: "user",
      content: `${SUMMARY_PREFIX}\n\n${summary}`,
    });
  }

  return (
    estimateTextTokens(SYSTEM_PROMPT) + estimateMessagesTokens(messageList)
  );
}

function buildToolHistoryFromThreadMessages(
  messages = [],
  limit = TOOL_HISTORY_LIMIT,
) {
  const normalized = [];
  for (const message of messages || []) {
    const role = normalizeRole(message);
    if (!role) continue;
    if (isSummaryLikeMessage(message)) continue;
    const content = normalizeMessageContent(message?.content).trim();
    if (!content) continue;
    normalized.push({ role, content });
  }
  return normalized.slice(-Math.max(1, Number(limit) || TOOL_HISTORY_LIMIT));
}

function buildRecentRoleContentMessages(messages = []) {
  return buildToolHistoryFromThreadMessages(messages, 50);
}

function getStateMessages(state) {
  const values = state?.values || state || {};
  return Array.isArray(values?.messages) ? values.messages : [];
}

async function safeGetThreadState(agent, runConfig) {
  try {
    return await agent.getState(runConfig);
  } catch (error) {
    return { values: { messages: [] } };
  }
}

function hasSummaryMessage(messages = []) {
  return Boolean(extractLatestSummaryMessage(messages));
}

function isSummaryLikeMessage(message) {
  const content = normalizeMessageContent(message?.content).trim();
  return (
    message?.additional_kwargs?.lc_source === "summarization" ||
    content.startsWith(SUMMARY_PREFIX)
  );
}

function normalizeRole(message) {
  if (!message) return null;
  const type =
    typeof message.getType === "function" ? message.getType() : message.role;
  if (!type) return null;
  const normalizedType = String(type).toLowerCase();
  if (normalizedType === "human" || normalizedType === "user") {
    return "user";
  }
  if (normalizedType === "ai" || normalizedType === "assistant") {
    return "assistant";
  }
  return null;
}
// 返回总结模型名称
function resolveSummaryModelName(primaryModel) {
  const configured = String(process.env.SUMMARY_MODEL || "").trim();
  if (!configured) return primaryModel;

  try {
    assertSupportedModel(configured);
    return configured;
  } catch (error) {
    return primaryModel;
  }
}

function readIntEnv(name, fallback, options = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;

  let result = Math.floor(value);
  if (Number.isFinite(options.min)) {
    result = Math.max(options.min, result);
  }
  if (Number.isFinite(options.max)) {
    result = Math.min(options.max, result);
  }
  return result;
}

function pickNumber(values = []) {
  for (const value of values) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  SUMMARY_PREFIX,
  run,
};
