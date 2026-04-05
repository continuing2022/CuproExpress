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

    if (!content) {
      return sendError(res, 400, "content required");
    }

    const ensuredConversation = await conversationService.ensureConversation({
      userId,
      conversationId,
      title,
      content,
    });

    if (!ensuredConversation.ok) {
      return sendError(
        res,
        ensuredConversation.status,
        ensuredConversation.error,
      );
    }

    const currentConversationId = ensuredConversation.conversationId;
    const history = await conversationService.getHistory(currentConversationId, 10);
    await conversationService.addUserMessage(currentConversationId, content);

    initSse(res);
    writeEvent(res, "started", {
      started: true,
      conversation_id: currentConversationId,
    });

    const keepAlive = startKeepAlive(res);
    let fullResponse = "";
    let assistantSaved = false;
    let streamClosed = false;

    async function saveAssistantMessage() {
      if (assistantSaved || !fullResponse) return null;

      const assistantMessage = await conversationService.addAssistantMessage(
        currentConversationId,
        fullResponse,
      );
      assistantSaved = true;
      return assistantMessage;
    }

    attachCloseCleanup(req, res, () => {
      streamClosed = true;
      clearInterval(keepAlive);
      saveAssistantMessage().catch((error) => {
        console.error("persist partial assistant message failed:", error);
      });
    });

    const result = await chatOrchestrator.run({
      content,
      model,
      networkConfig,
      history,
      onRetrieved(retrievalResult) {
        if (streamClosed) return;
        writeEvent(res, "retrieved", {
          retrieved: true,
          mode: retrievalResult.mode,
          meta: retrievalResult.meta || {},
        });
      },
      onChunk(chunk) {
        if (streamClosed) return;
        fullResponse += chunk;
        writeEvent(res, "chunk", { chunk });
      },
    });

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
    return res.json({ items: result.items, total: result.total, page, pageSize });
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

    const limit = req.query.limit ? Number(req.query.limit) : null;
    const messages = await conversationRepo.getMessages(req.params.id, limit);
    return res.json({ conversation_id: req.params.id, messages });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const ok = await conversationRepo.deleteConversation(req.params.id, req.user.id);
    if (!ok) {
      return sendError(res, 404, "conversation not found or not owned");
    }
    return res.json({ success: true });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

module.exports = router;
