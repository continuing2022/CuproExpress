const express = require("express");
const { conversationRepo } = require("../repositories");
const { authMiddleware } = require("../utils/auth");
const { sendError, sendInternalError } = require("../utils/response");
const { normalizePagination } = require("../utils/validators");
const conversationService = require("../services/conversationService");
const { createConversationObserver } = require("../services/observability");
const attachmentRepo = require("../repositories/attachmentRepo");
const attachmentStorage = require("../services/attachmentStorage");
const { normalizeAttachmentIds, buildMessageContent } = require("../services/attachmentContent");
const { assertSupportedModel } = require("../services/modelRegistry");
const userApiKeyRepo = require("../repositories/userApiKeyRepo");
const { withCredentials, getRequestApiKey } = require("../services/userCredentials");
const { createRequestScope, abortable } = require("../utils/cancellation");
const { runConversationStream } = require("../services/conversationStream");

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
  let observer = null;
  const scope = createRequestScope(req, res);
  try {
    scope.signal.throwIfAborted();
    const userId = req.user.id;
    const {
      conversation_id: conversationId,
      title,
      content,
      model,
      networkConfig,
      attachment_ids: attachmentIds,
    } = req.body;

    const normalizedContent = normalizeRequiredText(content);
    const ids = normalizeAttachmentIds(attachmentIds);
    if (!normalizedContent && !ids.length) {
      return sendError(res, 400, "content required");
    }

    const normalizedTitle = normalizeOptionalText(title);
    const normalizedModel = normalizeOptionalText(model) || "qwen-plus";
    const modelConfig = assertSupportedModel(normalizedModel);
    const userKeys = await abortable(userApiKeyRepo.load(userId), scope.signal);
    withCredentials(userKeys, () => getRequestApiKey(modelConfig.provider));
    if (ids.length && modelConfig.provider !== "dashscope") return sendError(res, 400, "附件仅使用阿里云模型分析，请选择 Qwen 系列模型");
    const attachments = [];
    for (const id of ids) {
      const file = await abortable(attachmentRepo.getOwned(id, userId), scope.signal);
      if (!file || file.message_id) return sendError(res, 400, "附件不存在、已发送或无权访问，请重新上传");
      if (file.mimeType.startsWith("image/")) file.data = await abortable(attachmentStorage.get(file.object_key), scope.signal);
      attachments.push(file);
    }
    scope.signal.throwIfAborted();
    const modelContent = buildMessageContent(normalizedContent, attachments);
    if (attachments.some((file) => file.mimeType.startsWith("image/")) && !modelConfig.supportsVision) {
      return sendError(res, 400, "图片需要使用视觉模型，请选择 Qwen3-VL-Plus");
    }
    const normalizedNetworkConfig =
      networkConfig &&
      typeof networkConfig === "object" &&
      !Array.isArray(networkConfig)
        ? networkConfig
        : {};
    observer = createConversationObserver({
      conversationId: conversationId || null,
      model: normalizedModel,
      content: normalizedContent,
      networkSearchEnabled: Boolean(normalizedNetworkConfig.search),
    });

    const ensuredConversation = await abortable(conversationService.ensureConversation({
      userId,
      conversationId,
      title: normalizedTitle,
      content: normalizedContent,
    }), scope.signal);

    if (!ensuredConversation.ok) {
      observer.fail({
        error: ensuredConversation.error,
        stage: "ensure_conversation",
      });
      return sendError(
        res,
        ensuredConversation.status,
        ensuredConversation.error,
      );
    }

    const currentConversationId = ensuredConversation.conversationId;
    if (modelConfig.provider !== "dashscope" && await abortable(attachmentRepo.conversationHasAttachments(currentConversationId), scope.signal)) {
      return sendError(res, 400, "此会话包含附件，请选择 Qwen 系列模型继续对话");
    }
    if (!modelConfig.supportsVision && await abortable(attachmentRepo.conversationHasImages(currentConversationId), scope.signal)) {
      return sendError(res, 400, "此会话包含图片，请选择 Qwen3-VL-Plus 继续对话");
    }
    scope.signal.throwIfAborted();
    observer.setConversationId(currentConversationId);
    const userMessage = await attachmentRepo.addUserMessage(
      currentConversationId,
      userId,
      normalizedContent,
      ids,
    );

    await runConversationStream({
      req, res, scope, userKeys, observer,
      conversationId: currentConversationId,
      userMessage, content: modelContent,
      model: normalizedModel, networkConfig: normalizedNetworkConfig,
    });
  } catch (error) {
    if (res.destroyed) return;
    if (scope.signal.reason?.code === "chat_timeout" && !res.headersSent) {
      observer?.fail({ error: new Error("chat timeout"), stage: "conversation_preparation" });
      return sendError(res, 504, "回答超时，请重试");
    }
    const statusCode =
      Number.isInteger(error?.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;
    const upstreamStatus = Number(error?.status);
    const publicMessage = upstreamStatus === 401 || upstreamStatus === 403
      ? "模型服务拒绝了你的 API Key，请在模型服务设置中检查密钥和权限"
      : upstreamStatus === 402 ? "模型服务余额不足，请检查你的服务商账户"
      : upstreamStatus === 429 ? "模型服务额度不足或请求过于频繁，请检查你的账户额度后重试"
      : statusCode === 500 ? "AI service error" : error.message;
    observer?.fail({
      error: new Error(publicMessage),
      stage: "conversation_route",
      streamClosedEarly: res.headersSent,
    });

    if (!res.headersSent) {
      if (statusCode === 500) {
        return sendError(res, upstreamStatus ? 502 : 500, publicMessage);
      }
      return sendError(res, statusCode, publicMessage);
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  } finally {
    scope.dispose();
    // Observer terminal methods are idempotent. Cover early validation exits
    // and disconnects during preparation as well as the normal stream path.
    observer?.fail({ error: new Error("request ended before stream completion"), stage: "conversation_cleanup", streamClosedEarly: res.headersSent });
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

    const limit = normalizePositiveInteger(req.query.limit, { max: 500 }) || 10;
    const beforeMessageId = normalizePositiveInteger(
      req.query.beforeMessageId,
      {
        max: Number.MAX_SAFE_INTEGER,
      },
    );

    const messages = await conversationRepo.getMessages(req.params.id, {
      limit,
      beforeMessageId,
    });
    const files = await attachmentRepo.forMessages(messages.map((message) => message.message_id));
    for (const message of messages) message.attachments = files.filter((file) => String(file.message_id) === String(message.message_id));
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
    require("../services/attachmentCleanup").cleanupAttachments().catch(() => {});
    return res.json({ success: true });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

module.exports = router;
