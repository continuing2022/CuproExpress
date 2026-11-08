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
const attachmentRepo = require("../repositories/attachmentRepo");
const { buildMessageContent } = require("./attachmentContent");
const { MODEL_REGISTRY } = require("./modelRegistry");
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
  observer,
  signal,
) {
  const middleware = summarizationMiddleware({
    model: createInstrumentedSummaryModel(summaryModelName, observer, {
      triggerTokens,
      keepMessages,
      signal,
    }),
    trigger: { tokens: triggerTokens },
    keep: { messages: keepMessages },
    summaryPrefix: SUMMARY_PREFIX,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    // A verified boundary requires the whole compacted prefix in the prompt.
    trimTokensToSummarize: Number.MAX_SAFE_INTEGER,
  });
  const summarize = middleware.beforeModel;
  return {
    ...middleware,
    async beforeModel(state, runtime) {
      const update = await summarize(state, runtime);
      signal?.throwIfAborted();
      if (!update?.messages) return update;

      const [, summary, ...retained] = update.messages;
      const text = stripSummaryPrefix(normalizeMessageContent(summary.content));
      if (!text || /^(Error generating summary:|Previous conversation was too long to summarize\.|No previous conversation history\.)/i.test(text)) {
        return;
      }

      const retainedIds = new Set(retained.map(message => message.id));
      const coveredIds = state.messages
        .filter(message => !retainedIds.has(message.id))
        .map(message => Math.max(
          message.additional_kwargs?.history_message_id || 0,
          message.additional_kwargs?.summary_boundary || 0,
        ));
      const firstRetainedId = Math.min(...retained
        .map(message => message.additional_kwargs?.history_message_id)
        .filter(id => id > 0));
      summary.additional_kwargs.summary_boundary = Math.max(
        0,
        ...coveredIds.filter(id => id < firstRetainedId),
      );
      return update;
    },
  };
}
// 创建配置化的Agent实例
function createConfiguredAgent({
  modelName,
  summaryModelName,
  networkSearchEnabled,
  triggerTokens,
  keepMessages,
  observer,
  tools = [],
  assistantMessageId,
  signal,
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
      createSummaryMiddleware(
        summaryModelName,
        triggerTokens,
        keepMessages,
        observer,
        signal,
      ),
      {
        name: "HistoryMessageTracking",
        afterAgent(state) {
          const message = state.messages.at(-1);
          if (!assistantMessageId || !AIMessage.isInstance(message) || !message.id) return;
          return { messages: [new AIMessage({
            ...message,
            additional_kwargs: {
              ...message.additional_kwargs,
              history_message_id: Number(assistantMessageId),
            },
          })] };
        },
      },
    ],
  });
}

async function executeRun({
  conversationId,
  content,
  model,
  networkConfig,
  pendingMessageId,
  assistantMessageId,
  observer,
  onRetrieved,
  onChunk,
  signal,
}) {
  signal?.throwIfAborted();
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
    signal,
    configurable: {
      thread_id: String(conversationId),
    },
  };

  const state =
    await conversationStateRepo.ensureConversationState(conversationId);
  signal?.throwIfAborted();
  const summaryBoundary = state?.summary_boundary_verified
    ? Number(state.last_summarized_message_id) || 0
    : 0;
  const persistedSummary = summaryBoundary > 0
    ? String(state?.running_summary || "").trim()
    : "";
  const summaryModelName = resolveSummaryModelName(model);
  const networkSearchEnabled = Boolean(networkConfig?.search);
  // 创建种子agent 用于恢复对话状态和记忆，并提供给工具使用
  const seedAgent = createConfiguredAgent({
    modelName: model,
    summaryModelName,
    networkSearchEnabled,
    triggerTokens: summaryTriggerTokens,
    keepMessages: summaryKeepMessages,
    observer,
    tools: [],
    signal,
  });
  // 恢复当前对话的记忆
  await ensureThreadSeeded({
    agent: seedAgent,
    runConfig,
    conversationId,
    pendingMessageId,
    persistedSummary,
    summaryBoundary,
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
  signal?.throwIfAborted();
  await retrievalTracker.reportInitial();
  const tools = createRetrievalTools({
    historyForTools,
    networkSearchEnabled,
    retrievalTracker,
    observer,
    signal,
  });
  const runAgent = createConfiguredAgent({
    modelName: model,
    summaryModelName,
    networkSearchEnabled,
    triggerTokens: summaryTriggerTokens,
    keepMessages: summaryKeepMessages,
    observer,
    tools,
    assistantMessageId,
    signal,
  });

  let fullResponse = "";
  let latestState = null;
  let usage = null;

  const stream = await runAgent.stream(
    { messages: [new HumanMessage({
      content,
      additional_kwargs: { history_message_id: Number(pendingMessageId) || 0 },
    })] },
    {
      ...runConfig,
      streamMode: ["messages", "values"],
    },
  );
  // 处理流式输出，提取消息块、最新状态和使用情况，并通过 onChunk 回调增量返回响应内容
  for await (const event of stream) {
    signal?.throwIfAborted();
    if (!Array.isArray(event) || event.length < 2) continue;
    const [mode, payload] = event;
    if (mode === "messages") {
      const [message, metadata] = Array.isArray(payload) ? payload : [];
      const chunk = extractAssistantChunk(message, metadata);
      if (chunk) {
        fullResponse += chunk;
        await onChunk?.(chunk);
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

  signal?.throwIfAborted();
  if (!fullResponse) {
    const fallbackResponse = extractFinalAssistantText(
      latestState?.messages || [],
    );
    if (fallbackResponse) {
      fullResponse = fallbackResponse;
      if (typeof onChunk === "function") {
        await onChunk(fallbackResponse);
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
  // 持久化总结到数据库，并返回是否更新了总结
  signal?.throwIfAborted();
  const summaryRefreshed = await persistSummary({
    conversationId,
    currentState: state,
    summary: summaryPayload,
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
  observer,
  signal,
}) {
  const localRagTool = tool(
    async ({ query }) => {
      const retrieval = await runLocalRagRetrieval({
        query,
        historyForTools,
        observer,
        signal,
      });
      signal?.throwIfAborted();
      await retrievalTracker.capture(retrieval);
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
      const retrieval = await runWebSearchRetrieval({
        query,
        historyForTools,
        observer,
        signal,
      });
      signal?.throwIfAborted();
      await retrievalTracker.capture(retrieval);
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

async function runLocalRagRetrieval({ query, historyForTools, observer, signal }) {
  const startedAt = Date.now();
  try {
    const result = await ragService.retrieveContext({
      query,
      history: historyForTools,
      options: { signal },
      signal,
    });
    const normalized = normalizeRetrievalResult(result, "local_rag");
    observer?.recordToolCall({
      toolName: "local_rag_retrieve",
      query,
      success: !isRetrievalTransportFailure(normalized, "local_rag"),
      contextHit: Boolean(normalized.contextText.trim()),
      durationMs: Date.now() - startedAt,
      mode: normalized.mode,
      meta: normalized.meta,
    });
    return normalized;
  } catch (error) {
    signal?.throwIfAborted();
    observer?.recordToolCall({
      toolName: "local_rag_retrieve",
      query,
      success: false,
      contextHit: false,
      durationMs: Date.now() - startedAt,
      mode: "direct_chat",
      errorMessage: "知识库检索暂不可用",
    });
    return {
      mode: "direct_chat",
      contextText: "",
      meta: {
        fallbackFrom: "local_rag",
        reason: "retrieval_error",
        message: "知识库检索暂不可用，请检查个人百炼 Key 和知识库服务",
      },
    };
  }
}

async function runWebSearchRetrieval({ query, historyForTools, observer, signal }) {
  const startedAt = Date.now();
  try {
    const result = await searchTool.retrieveContext({
      query,
      history: historyForTools,
      options: { signal },
      signal,
    });
    const normalized = normalizeRetrievalResult(result, "web_search");
    observer?.recordToolCall({
      toolName: "web_search_retrieve",
      query,
      success: !isRetrievalTransportFailure(normalized, "web_search"),
      contextHit: Boolean(normalized.contextText.trim()),
      durationMs: Date.now() - startedAt,
      mode: normalized.mode,
      meta: normalized.meta,
    });
    return normalized;
  } catch (error) {
    signal?.throwIfAborted();
    observer?.recordToolCall({
      toolName: "web_search_retrieve",
      query,
      success: false,
      contextHit: false,
      durationMs: Date.now() - startedAt,
      mode: "direct_chat",
      errorMessage: String(error?.message || error),
    });
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

function createInstrumentedSummaryModel(
  summaryModelName,
  observer,
  { triggerTokens, keepMessages, signal },
) {
  const model = getLangChainModelForName(summaryModelName, {
    temperature: 0.1,
    maxTokens: 1200,
  });
  const originalInvoke =
    typeof model?.invoke === "function" ? model.invoke.bind(model) : null;

  if (!originalInvoke) {
    return model;
  }

  model.invoke = async (...args) => {
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      const result = await originalInvoke(args[0], { ...args[1], signal });
      signal?.throwIfAborted();
      observer?.recordSummaryCall({
        success: true,
        durationMs: Date.now() - startedAt,
        modelName: summaryModelName,
        triggerTokens,
        keepMessages,
        method: "invoke",
      });
      return result;
    } catch (error) {
      observer?.recordSummaryCall({
        success: false,
        durationMs: Date.now() - startedAt,
        modelName: summaryModelName,
        triggerTokens,
        keepMessages,
        method: "invoke",
        errorMessage: "摘要模型调用失败，请检查个人 Key、权限与额度",
      });
      throw error;
    }
  };

  return model;
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
    async reportInitial() {
      if (typeof onRetrieved !== "function") return;
      await onRetrieved({
        mode: this.mode,
        meta: this.meta,
        diagnostics: { contextProfile },
      });
    },
    async capture(retrieval) {
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
        await onRetrieved({
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

function isRetrievalTransportFailure(retrieval, fallbackMode) {
  const meta = isPlainObject(retrieval?.meta) ? retrieval.meta : {};
  return (
    meta.fallbackFrom === fallbackMode &&
    (meta.reason === "retrieval_error" ||
      meta.reason === "missing_bocha_api_key")
  );
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

function buildSummaryMessage(summaryText, summaryBoundary) {
  return new HumanMessage({
    content: `${SUMMARY_PREFIX}\n\n${summaryText}`,
    additional_kwargs: {
      lc_source: "summarization",
      summary_boundary: summaryBoundary,
    },
  });
}

async function ensureThreadSeeded({
  agent,
  runConfig,
  conversationId,
  pendingMessageId,
  persistedSummary,
  summaryBoundary,
  historyLimit,
}) {
  const existingState = await safeGetThreadState(agent, runConfig);
  runConfig.signal?.throwIfAborted();
  if (getStateMessages(existingState).length > 0) {
    return;
  }

  const historicalMessages = await conversationRepo.getMessagesAfter(
    conversationId,
    persistedSummary ? summaryBoundary : 0,
    { beforeMessageId: pendingMessageId, limit: historyLimit, forRecovery: true },
  );

  const seedMessages = [];
  if (persistedSummary) {
    seedMessages.push(buildSummaryMessage(persistedSummary, summaryBoundary));
  }
  for (const message of historicalMessages) {
    runConfig.signal?.throwIfAborted();
    const Message = message.role === "assistant" ? AIMessage : HumanMessage;
    seedMessages.push(new Message({
      content: buildMessageContent(message.content, await attachmentRepo.forMessages([message.message_id], true)),
      additional_kwargs: { history_message_id: Number(message.message_id) },
    }));
  }

  if (seedMessages.length === 0) {
    return;
  }

  runConfig.signal?.throwIfAborted();
  await agent.updateState(runConfig, { messages: seedMessages });
}

async function persistSummary({ conversationId, currentState, summary }) {
  if (!summary?.summaryText || !summary.boundary) return false;
  if (currentState?.summary_boundary_verified &&
      currentState.running_summary?.trim() === summary.summaryText &&
      Number(currentState.last_summarized_message_id) === summary.boundary) {
    return false;
  }

  return conversationStateRepo.updateConversationSummary({
    conversationId,
    runningSummary: summary.summaryText,
    summaryVersion: Number(currentState?.summary_version) || 0,
    lastSummarizedMessageId: summary.boundary,
  });
}

function extractLatestSummaryMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = normalizeMessageContent(message?.content).trim();
    if (!content) continue;

    const isSummaryMessage = message?.additional_kwargs?.lc_source === "summarization";

    if (!isSummaryMessage) continue;
    return {
      boundary: message.additional_kwargs.summary_boundary,
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
    runConfig.signal?.throwIfAborted();
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
  if (MODEL_REGISTRY[primaryModel]?.supportsVision) return primaryModel;
  const configured = String(process.env.SUMMARY_MODEL || "").trim();
  if (!configured) return primaryModel;

  try {
    const summaryConfig = assertSupportedModel(configured);
    // Summaries use the same provider credentials as the primary model.
    if (MODEL_REGISTRY[primaryModel]?.provider !== summaryConfig.provider) return primaryModel;
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

async function run(options) {
  try {
    return await executeRun(options);
  } catch (error) {
    // Discard interrupted tool/checkpoint state. The next request seeds from
    // persisted summary and completed messages rather than a partial tool call.
    await sharedCheckpointer.deleteThread(String(options.conversationId));
    throw error;
  }
}

module.exports = {
  SUMMARY_PREFIX,
  run,
};
