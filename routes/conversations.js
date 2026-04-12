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
    // 确保当前对话
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
    // 获取当前对话ID
    const currentConversationId = ensuredConversation.conversationId;
    // 添加用户消息
    const userMessage = await conversationService.addUserMessage(
      currentConversationId,
      content,
    );
    // 初始化SSE连接
    initSse(res);
    // 发送对话开始事件
    writeEvent(res, "started", {
      started: true,
      conversation_id: currentConversationId,
    });
    // 保持连接活跃，定期发送keep-alive事件
    const keepAlive = startKeepAlive(res);
    let fullResponse = ""; // 用于累积助手消息的完整内容，以便在连接关闭时保存当前响应状态
    let assistantSaved = false;
    let streamClosed = false;
    // 定义一个函数用于保存助手消息，确保在连接关闭时也能保存当前的响应内容
    async function saveAssistantMessage() {
      if (assistantSaved || !fullResponse) return null;

      const assistantMessage = await conversationService.addAssistantMessage(
        currentConversationId,
        fullResponse,
      );
      assistantSaved = true;
      return assistantMessage;
    }
    // 开启关闭连接的清理操作，确保在连接关闭时保存助手消息并清理资源
    attachCloseCleanup(req, res, () => {
      streamClosed = true;
      clearInterval(keepAlive);
      saveAssistantMessage().catch((error) => {
        console.error("persist partial assistant message failed:", error);
      });
    });
    // 开始生成
    const result = await chatOrchestrator.run({
      conversationId: currentConversationId,
      content,
      model,
      networkConfig,
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
      // 在接收到每个流式响应块时调用onChunk回调函数，累积助手消息内容并通过SSE发送给客户端
      onChunk(chunk) {
        if (streamClosed) return;
        fullResponse += chunk;
        writeEvent(res, "chunk", { chunk });
      },
    });

    const assistantMessage = await saveAssistantMessage();

    conversationService
      .maybeRefreshConversationSummary({
        conversationId: currentConversationId,
        model,
      })
      .catch((error) => {
        console.error("post-response summary refresh failed:", error);
      });

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

    const limit = req.query.limit ? Number(req.query.limit) : null;
    const messages = await conversationRepo.getMessages(req.params.id, limit);
    return res.json({ conversation_id: req.params.id, messages });
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
