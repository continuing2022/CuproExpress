const express = require("express");
const { conversationRepo } = require("../repositories");
const { authMiddleware } = require("../utils/auth");
const { sendError, sendInternalError } = require("../utils/response");
const { normalizePagination } = require("../utils/validators");
const conversationService = require("../services/conversationService");
const chatOrchestrator = require("../services/chatOrchestrator");
const {
  initSse,
  writeEvent,
  startKeepAlive,
  attachCloseCleanup,
} = require("../services/sseService");

const router = express.Router();

function normalizeRequiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizePositiveInteger(value, options = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;

  let normalized = Math.floor(parsed);
  if (normalized < 1) return null;

  if (Number.isFinite(options.max)) {
    normalized = Math.min(normalized, options.max);
  }
  return normalized;
}

router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      conversation_id: conversationId,
      title,
      content,
      model,
      networkConfig,
    } = req.body;

    const normalizedContent = normalizeRequiredText(content);
    if (!normalizedContent) {
      return sendError(res, 400, "content required");
    }

    const normalizedTitle = normalizeOptionalText(title);
    const normalizedModel = normalizeOptionalText(model) || "qwen-plus";
    const normalizedNetworkConfig =
      networkConfig &&
      typeof networkConfig === "object" &&
      !Array.isArray(networkConfig)
        ? networkConfig
        : {};

    const ensuredConversation = await conversationService.ensureConversation({
      userId,
      conversationId,
      title: normalizedTitle,
      content: normalizedContent,
    });

    if (!ensuredConversation.ok) {
      return sendError(
        res,
        ensuredConversation.status,
        ensuredConversation.error,
      );
    }

    const currentConversationId = ensuredConversation.conversationId;
    const userMessage = await conversationService.addUserMessage(
      currentConversationId,
      normalizedContent,
    );

    initSse(res);
    writeEvent(res, "started", {
      started: true,
      conversation_id: currentConversationId,
    });

    const keepAlive = startKeepAlive(res);
    let fullResponse = "";
    let assistantSaved = false;
    let assistantSavePromise = null;
    let streamClosed = false;

    async function saveAssistantMessage() {
      if (assistantSaved || !fullResponse) return null;
      if (assistantSavePromise) return assistantSavePromise;
      assistantSavePromise = (async () => {
        const assistantMessage = await conversationService.addAssistantMessage(
          currentConversationId,
          fullResponse,
        );
        assistantSaved = true;
        return assistantMessage;
      })();
      try {
        return await assistantSavePromise;
      } finally {
        assistantSavePromise = null;
      }
    }

    attachCloseCleanup(req, res, () => {
      streamClosed = true;
      clearInterval(keepAlive);
      saveAssistantMessage().catch((error) => {
        console.error("persist partial assistant message failed:", error);
      });
    });

    const result = await chatOrchestrator.run({
      conversationId: currentConversationId,
      content: normalizedContent,
      model: normalizedModel,
      networkConfig: normalizedNetworkConfig,
      pendingMessageId: userMessage.message_id,
      onRetrieved(retrievalResult) {
        if (streamClosed) return;
        writeEvent(res, "retrieved", {
          retrieved: true,
          mode: retrievalResult.mode,
          meta: retrievalResult.meta || {},
          context_profile: retrievalResult.diagnostics?.contextProfile || {},
        });
      },
      onChunk(chunk) {
        if (streamClosed) return;
        const safeChunk = String(chunk || "");
        if (!safeChunk) return;
        fullResponse += safeChunk;
        writeEvent(res, "chunk", { chunk: safeChunk });
      },
    });

    if (!fullResponse && result.fullResponse) {
      fullResponse = String(result.fullResponse);
    }

    const assistantMessage = await saveAssistantMessage();

    clearInterval(keepAlive);
    if (streamClosed) {
      return res.end();
    }

    writeEvent(res, "done", {
      done: true,
      conversation_id: currentConversationId,
      message_id: assistantMessage?.message_id,
      mode: result.mode,
      meta: result.retrievalMeta,
      diagnostics: result.telemetry,
    });
    return res.end();
  } catch (error) {
    console.error("conversation stream error:", error);
    if (!res.headersSent) {
      return sendInternalError(res, error);
    }
    writeEvent(res, "error", { error: "AI service error" });
    return res.end();
  }
});

router.get("/", authMiddleware, async (req, res) => {
  try {
    const { page, pageSize } = normalizePagination(req.query, {
      page: 1,
      pageSize: 20,
      maxPageSize: 100,
    });
    const result = await conversationRepo.listConversations(
      req.user.id,
      page,
      pageSize,
    );
    return res.json({
      items: result.items,
      total: result.total,
      page,
      pageSize,
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.get("/:id/messages", authMiddleware, async (req, res) => {
  try {
    const ownership = await conversationRepo.assertConversationOwner(
      req.user.id,
      req.params.id,
    );
    if (!ownership.ok) {
      return sendError(res, ownership.status, ownership.error);
    }

    const limit =
      normalizePositiveInteger(req.query.limit, { max: 500 }) || 10;
    const beforeMessageId = normalizePositiveInteger(req.query.beforeMessageId, {
      max: Number.MAX_SAFE_INTEGER,
    });

    const messages = await conversationRepo.getMessages(req.params.id, {
      limit,
      beforeMessageId,
    });
    console.log("[GET /conversations/:id/messages]", {
      conversationId: req.params.id,
      userId: req.user.id,
      limit,
      beforeMessageId: beforeMessageId ?? null,
      messagesCount: messages.length,
      firstMessageId: messages[0]?.message_id ?? null,
      lastMessageId: messages[messages.length - 1]?.message_id ?? null,
    });
    const oldestLoadedMessageId = messages[0]?.message_id ?? null;
    const remainingCount = oldestLoadedMessageId
      ? await conversationRepo.countMessagesAfter(req.params.id, 0, {
          beforeMessageId: oldestLoadedMessageId,
        })
      : 0;

    return res.json({
      conversation_id: req.params.id,
      messages,
      hasMore: remainingCount > 0,
      oldestLoadedMessageId,
      remainingCount,
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const ownership = await conversationRepo.assertConversationOwner(
      req.user.id,
      req.params.id,
    );
    if (!ownership.ok) {
      return sendError(res, ownership.status, ownership.error);
    }

    const title = String(req.body?.title || "").trim();
    if (!title) {
      return sendError(res, 400, "title required");
    }
    if (title.length > 255) {
      return sendError(res, 400, "title too long");
    }

    const conversation = await conversationRepo.updateConversationTitle(
      req.params.id,
      req.user.id,
      title,
    );
    if (!conversation) {
      return sendError(res, 404, "conversation not found or not owned");
    }

    return res.json({
      success: true,
      conversation: {
        conversation_id: conversation.conversation_id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
      },
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const ok = await conversationRepo.deleteConversation(
      req.params.id,
      req.user.id,
    );
    if (!ok) {
      return sendError(res, 404, "conversation not found or not owned");
    }
    return res.json({ success: true });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

module.exports = router;
