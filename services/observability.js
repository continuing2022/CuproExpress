const { randomUUID } = require("node:crypto");

const metricsState = {
  activeRequests: 0,
  totalRequests: 0,
  completedRequests: 0,
  failedRequests: 0,
  toolStats: Object.create(null),
};

function isLoggingEnabled() {
  return String(process.env.OBSERVE_CHAT_METRICS || "1").trim() !== "0";
}

function isVerboseLoggingEnabled() {
  return String(process.env.OBSERVE_CHAT_VERBOSE || "0").trim() === "1";
}

function nowIso() {
  return new Date().toISOString();
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function createRequestId() {
  if (typeof randomUUID === "function") return randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function computeSuccessRate(successCount, failureCount) {
  const attempts = Number(successCount || 0) + Number(failureCount || 0);
  if (!attempts) return null;
  return roundNumber((Number(successCount || 0) / attempts) * 100, 2);
}

function getOrCreateToolStats(toolName) {
  const key = String(toolName || "unknown_tool");
  if (!metricsState.toolStats[key]) {
    metricsState.toolStats[key] = {
      attempts: 0,
      success: 0,
      failure: 0,
      totalDurationMs: 0,
      lastDurationMs: null,
      lastStatus: "unknown",
    };
  }
  return metricsState.toolStats[key];
}

function buildToolStatsSnapshot() {
  return Object.fromEntries(
    Object.entries(metricsState.toolStats).map(([toolName, stats]) => [
      toolName,
      {
        attempts: stats.attempts,
        success: stats.success,
        failure: stats.failure,
        successRate: computeSuccessRate(stats.success, stats.failure),
        averageDurationMs: stats.attempts
          ? roundNumber(stats.totalDurationMs / stats.attempts, 2)
          : null,
        lastDurationMs: stats.lastDurationMs,
        lastStatus: stats.lastStatus,
      },
    ]),
  );
}

function buildConcurrencySnapshot() {
  const finishedRequests =
    metricsState.completedRequests + metricsState.failedRequests;
  return {
    activeRequests: metricsState.activeRequests,
    totalRequests: metricsState.totalRequests,
    completedRequests: metricsState.completedRequests,
    failedRequests: metricsState.failedRequests,
    successRate: finishedRequests
      ? roundNumber(
          (metricsState.completedRequests / finishedRequests) * 100,
          2,
        )
      : null,
  };
}

function logEvent(type, payload = {}) {
  if (!isLoggingEnabled()) return;
  console.info(
    `[observe][${type}]`,
    JSON.stringify(
      {
        ts: nowIso(),
        ...payload,
      },
      null,
      0,
    ),
  );
}

function logVerboseEvent(type, payload = {}) {
  if (!isVerboseLoggingEnabled()) return;
  logEvent(type, payload);
}

function pickMaxToolDuration(toolCalls, toolName) {
  const durations = toolCalls
    .filter((item) => item.toolName === toolName)
    .map((item) => Number(item.durationMs) || 0);
  if (!durations.length) return null;
  return roundNumber(Math.max(...durations), 2);
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function summarizeToolUsage(toolCalls = []) {
  const localRagCalls = toolCalls.filter(
    (item) => item.toolName === "local_rag_retrieve",
  );
  const webSearchCalls = toolCalls.filter(
    (item) => item.toolName === "web_search_retrieve",
  );

  const localRagUsed = localRagCalls.length > 0;
  const webSearchUsed = webSearchCalls.length > 0;
  const localRagHit = localRagCalls.some((item) => item.contextHit);
  const webSearchHit = webSearchCalls.some((item) => item.contextHit);

  let retrievalPath = "direct_chat";
  if (localRagUsed && webSearchUsed) {
    retrievalPath = "local_rag+web_search";
  } else if (localRagUsed) {
    retrievalPath = "local_rag";
  } else if (webSearchUsed) {
    retrievalPath = "web_search";
  }

  return {
    localRagUsed,
    webSearchUsed,
    localRagHit,
    webSearchHit,
    retrievalPath,
  };
}

function buildRedirect(meta = {}) {
  const from = String(meta?.fallbackFrom || "").trim();
  const reason = String(meta?.reason || "").trim();
  if (!from && !reason) return null;
  return `${from || "unknown"}:${reason || "fallback"}`;
}

function computeStageBottleneck(stageMap = {}) {
  let bottleneck = null;
  for (const [stage, rawDurationMs] of Object.entries(stageMap)) {
    const durationMs = roundNumber(rawDurationMs, 2);
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    if (!bottleneck || durationMs > bottleneck.durationMs) {
      bottleneck = { stage, durationMs };
    }
  }
  return bottleneck;
}

function buildOptimizationHint({
  bottleneck,
  errors = [],
  redirects = [],
  toolCalls = [],
}) {
  if (errors.length) {
    return "先处理报错链路，补充超时控制、参数校验和失败重试。";
  }
  if (redirects.some((item) => item.includes("missing_bocha_api_key"))) {
    return "联网检索缺少配置，补齐 API Key 或直接关闭网络搜索。";
  }
  if (bottleneck?.stage === "rerankMs") {
    return "优先缩小 rerank 输入规模，降低 fusionTopK 或更换更轻量 rerank 模型。";
  }
  if (bottleneck?.stage === "webSearchMs") {
    return "优先缓存公网结果，并限制联网搜索只在必要问题触发。";
  }
  if (
    bottleneck?.stage === "localRagMs" ||
    bottleneck?.stage === "ragTotalMs"
  ) {
    return "优先优化本地检索链路，减少召回规模并复用索引与结果缓存。";
  }
  if (bottleneck?.stage === "summaryMs") {
    return "优先提高摘要触发阈值，减少长对话中的摘要调用频率。";
  }
  if (bottleneck?.stage === "generationMs") {
    return "优先压缩上下文和工具返回内容，减少模型主回答生成负担。";
  }
  if (toolCalls.some((item) => item.contextHit === false)) {
    return "工具有空命中，建议优化检索 query 改写与召回策略。";
  }
  return "当前链路正常，优先关注耗时最高阶段并做缓存或减量。";
}

function createConversationObserver({
  conversationId,
  model,
  content,
  networkSearchEnabled,
}) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const state = {
    conversationId: conversationId || null,
    finished: false,
    firstRetrievedMs: null,
    firstChunkMs: null,
    chunkCount: 0,
    chunkChars: 0,
    summaryCalls: [],
    toolCalls: [],
    errors: [],
    redirects: [],
    retrievals: [],
    aborted: false,
  };

  metricsState.activeRequests += 1;
  metricsState.totalRequests += 1;

  logEvent("chat_start", {
    requestId,
    conversationId: state.conversationId,
    model,
    search: Boolean(networkSearchEnabled),
    questionChars: String(content || "").length,
    activeRequests: metricsState.activeRequests,
  });

  function finishRequestCounters({ failed }) {
    if (state.finished) return false;
    state.finished = true;
    metricsState.activeRequests = Math.max(0, metricsState.activeRequests - 1);
    if (failed) {
      metricsState.failedRequests += 1;
    } else {
      metricsState.completedRequests += 1;
    }
    return true;
  }

  return {
    requestId,
    setConversationId(nextConversationId) {
      state.conversationId = nextConversationId || state.conversationId;
    },
    markSseOpened() {
      logVerboseEvent("sse_opened", {
        requestId,
        conversationId: state.conversationId,
        elapsedMs: Date.now() - startedAt,
      });
    },
    markRetrieved({ mode, meta }) {
      if (state.firstRetrievedMs === null) {
        state.firstRetrievedMs = Date.now() - startedAt;
      }
      const normalizedMode = String(mode || "direct_chat");
      const redirect = buildRedirect(meta || {});
      if (redirect) {
        state.redirects.push(`retrieval:${redirect}`);
      }
      state.retrievals.push({
        mode: normalizedMode,
        elapsedMs: Date.now() - startedAt,
      });
      logVerboseEvent("retrieval_event", {
        requestId,
        conversationId: state.conversationId,
        mode: normalizedMode,
        elapsedMs: Date.now() - startedAt,
        redirect,
      });
    },
    markFirstChunk(chunk) {
      if (state.firstChunkMs !== null) return;
      state.firstChunkMs = Date.now() - startedAt;
      logVerboseEvent("first_response", {
        requestId,
        conversationId: state.conversationId,
        firstResponseMs: state.firstChunkMs,
        firstChunkChars: String(chunk || "").length,
      });
    },
    markChunk(chunk) {
      const text = String(chunk || "");
      if (!text) return;
      state.chunkCount += 1;
      state.chunkChars += text.length;
    },
    recordToolCall({
      toolName,
      query,
      success,
      contextHit,
      durationMs,
      mode,
      meta,
      errorMessage,
    }) {
      const normalizedToolName = String(toolName || "unknown_tool");
      const normalizedSuccess = Boolean(success);
      const normalizedDurationMs = roundNumber(durationMs, 2);
      const normalizedMode = String(mode || "direct_chat");
      const normalizedMeta = meta || {};
      const redirect = buildRedirect(normalizedMeta);
      const stats = getOrCreateToolStats(normalizedToolName);
      stats.attempts += 1;
      stats.totalDurationMs += Number(durationMs) || 0;
      stats.lastDurationMs = normalizedDurationMs;
      stats.lastStatus = normalizedSuccess ? "success" : "failure";
      if (normalizedSuccess) {
        stats.success += 1;
      } else {
        stats.failure += 1;
      }

      const toolCall = {
        toolName: normalizedToolName,
        success: normalizedSuccess,
        contextHit: Boolean(contextHit),
        durationMs: normalizedDurationMs,
        mode: normalizedMode,
        queryChars: String(query || "").length,
        redirect,
      };
      state.toolCalls.push(toolCall);

      if (redirect) {
        state.redirects.push(`${normalizedToolName}:${redirect}`);
      }
      if (errorMessage) {
        state.errors.push(`${normalizedToolName}:${String(errorMessage)}`);
      }

      const logType = normalizedSuccess ? "tool_call" : "tool_error";
      const logPayload = {
        requestId,
        conversationId: state.conversationId,
        tool: normalizedToolName,
        ok: normalizedSuccess,
        hit: Boolean(contextHit),
        costMs: normalizedDurationMs,
        mode: normalizedMode,
        redirect,
        error: errorMessage || null,
        successRate: computeSuccessRate(stats.success, stats.failure),
      };
      if (
        !normalizedSuccess ||
        redirect ||
        !contextHit ||
        isVerboseLoggingEnabled()
      ) {
        logEvent(logType, logPayload);
      }
    },
    recordSummaryCall({
      success,
      durationMs,
      modelName,
      triggerTokens,
      keepMessages,
      method,
      errorMessage,
    }) {
      const summaryCall = {
        success: Boolean(success),
        durationMs: roundNumber(durationMs, 2),
        modelName,
        triggerTokens,
        keepMessages,
        method: method || "invoke",
      };
      state.summaryCalls.push(summaryCall);
      if (errorMessage) {
        state.errors.push(`summary:${String(errorMessage)}`);
      }

      if (!success || isVerboseLoggingEnabled()) {
        logEvent("summary_call", {
          requestId,
          conversationId: state.conversationId,
          ok: Boolean(success),
          costMs: summaryCall.durationMs,
          model: modelName,
          triggerTokens,
          keepMessages,
          error: errorMessage || null,
        });
      }
    },
    finish({
      fullResponse,
      mode,
      retrievalMeta,
      telemetry,
      streamClosedEarly,
      assistantMessageId,
    }) {
      if (!finishRequestCounters({ failed: false })) return;

      const fullResponseMs = Date.now() - startedAt;
      const summaryMs = roundNumber(
        state.summaryCalls.reduce(
          (total, item) => total + (Number(item.durationMs) || 0),
          0,
        ),
        2,
      );
      const localRagMs = pickMaxToolDuration(
        state.toolCalls,
        "local_rag_retrieve",
      );
      const webSearchMs = pickMaxToolDuration(
        state.toolCalls,
        "web_search_retrieve",
      );
      const retrievalDiagnostics =
        retrievalMeta?.retrievalDiagnostics ||
        telemetry?.retrievalDiagnostics ||
        {};
      const ragTotalMs = roundNumber(
        retrievalDiagnostics.totalMs ??
          retrievalMeta?.ragServiceLatencyMs ??
          localRagMs,
        2,
      );
      const knownStageCost =
        Number(localRagMs || 0) +
        Number(webSearchMs || 0) +
        Number(summaryMs || 0);
      const generationMs = roundNumber(
        Math.max(0, fullResponseMs - knownStageCost),
        2,
      );
      const timings = {
        firstResponseMs: state.firstChunkMs,
        fullResponseMs,
        localRagMs,
        webSearchMs,
        summaryMs: summaryMs || null,
        ragTotalMs,
        vectorMs: roundNumber(retrievalDiagnostics.vectorMs, 2),
        bm25Ms: roundNumber(retrievalDiagnostics.bm25Ms, 2),
        rerankMs: roundNumber(retrievalDiagnostics.rerankMs, 2),
        generationMs,
      };
      const bottleneck = computeStageBottleneck({
        localRagMs,
        webSearchMs,
        summaryMs,
        ragTotalMs,
        vectorMs: retrievalDiagnostics.vectorMs,
        bm25Ms: retrievalDiagnostics.bm25Ms,
        rerankMs: retrievalDiagnostics.rerankMs,
        generationMs,
      });
      const behaviors = uniqueValues([
        `mode:${String(mode || "direct_chat")}`,
        state.summaryCalls.length
          ? `summary:${state.summaryCalls.length}`
          : null,
        ...state.toolCalls.map((item) => {
          const result = item.success
            ? item.contextHit
              ? "hit"
              : "empty"
            : "fail";
          return `${item.toolName}:${result}`;
        }),
      ]);
      const redirects = uniqueValues(state.redirects);
      const errors = uniqueValues(state.errors);
      const toolUsage = summarizeToolUsage(state.toolCalls);

      logEvent("chat_summary", {
        requestId,
        conversationId: state.conversationId,
        assistantMessageId: assistantMessageId ?? null,
        ok: !streamClosedEarly && !state.aborted,
        interrupted: Boolean(streamClosedEarly || state.aborted),
        toolUsage,
        behaviors,
        redirects,
        errors,
        timings,
        bottleneck,
        optimize: buildOptimizationHint({
          bottleneck,
          errors,
          redirects,
          toolCalls: state.toolCalls,
        }),
        chunkCount: state.chunkCount,
        responseChars: String(fullResponse || "").length,
        ragContextTokens: telemetry?.rag_context_tokens ?? null,
        concurrency: buildConcurrencySnapshot(),
        toolStats: buildToolStatsSnapshot(),
      });
    },
    fail({ error, stage, streamClosedEarly }) {
      if (!finishRequestCounters({ failed: true })) return;
      const message = String(error?.message || error || "unknown error");
      state.errors.push(`${stage || "unknown"}:${message}`);
      logEvent("chat_error", {
        requestId,
        conversationId: state.conversationId,
        stage: stage || "unknown",
        interrupted: Boolean(streamClosedEarly),
        errors: uniqueValues(state.errors),
        redirects: uniqueValues(state.redirects),
        timings: {
          firstResponseMs: state.firstChunkMs,
          elapsedMs: Date.now() - startedAt,
        },
        optimize: "优先检查失败阶段的参数、超时和依赖服务可用性。",
        concurrency: buildConcurrencySnapshot(),
      });
    },
    abort({ reason }) {
      state.aborted = true;
      logEvent("chat_abort", {
        requestId,
        conversationId: state.conversationId,
        reason: reason || "client_closed",
        elapsedMs: Date.now() - startedAt,
        chunkCount: state.chunkCount,
      });
    },
  };
}

function getMetricsSnapshot() {
  return {
    ...buildConcurrencySnapshot(),
    tools: buildToolStatsSnapshot(),
  };
}

function resetMetricsSnapshotForTest() {
  metricsState.activeRequests = 0;
  metricsState.totalRequests = 0;
  metricsState.completedRequests = 0;
  metricsState.failedRequests = 0;
  metricsState.toolStats = Object.create(null);
}

module.exports = {
  createConversationObserver,
  getMetricsSnapshot,
  resetMetricsSnapshotForTest,
};
