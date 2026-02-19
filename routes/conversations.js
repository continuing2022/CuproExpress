const express = require("express");
const db = require("../db");
const auth = require("./auth");
const openaiService = require("../openai.js");
const router = express.Router();

const sendErr = (res, status, msg) => res.status(status).json({ error: msg });

// 简单领域判断：基于关键词匹配判断是否属于铜及铜合金相关问题
function isCopperQuestion(question) {
  if (!question || typeof question !== "string") return false;
  const q = question.toLowerCase();
  const keywords = [
    "铜",
    "铜合金",
    "黄铜",
    "青铜",
    "铜锌",
    "铜锡",
    "铜镍",
    "铜材",
    "铜基",
    "brass",
    "bronze",
    "copper",
    "cu",
  ];
  return keywords.some((k) => q.includes(k));
}

// 开始新对话或在已有对话中继续发送消息
router.post("/", auth.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversation_id, title, content } = req.body;
    if (!content) return sendErr(res, 400, "content required");
    let convId = conversation_id;
    if (!convId) {
      const autoTitle =
        title || (content.length > 60 ? content.slice(0, 60) : content);
      const conv = await db.createConversation(userId, autoTitle);
      convId = conv.conversation_id;
    } else {
      const pool = db._pool();
      const [rows] = await pool.execute(
        "SELECT user_id FROM conversations WHERE conversation_id = ?",
        [convId],
      );
      if (!rows || rows.length === 0)
        return sendErr(res, 404, "conversation not found");
      if (rows[0].user_id !== userId) return sendErr(res, 403, "forbidden");
    }

    await db.addMessage(convId, "user", content);

    // 领域判断：若非铜及铜合金相关问题，通过 SSE 把提示以助理消息形式返回并保存，前端可像正常回复展示
    if (!isCopperQuestion(content)) {
      // 设置 SSE 响应头
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (res.flushHeaders) res.flushHeaders();
      // 发送开始事件
      res.write(
        `data: ${JSON.stringify({ started: true, conversation_id: convId })}\n\n`,
      );
      const keepAlive = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch (e) {
          // ignore
        }
      }, 15000);

      const assistantReply = "本系统仅支持铜及铜合金领域问题";
      // 存储助理消息
      const assistantMsg = await db.addMessage(
        convId,
        "assistant",
        assistantReply,
      );
      // 发送作为一个 chunk
      res.write(`data: ${JSON.stringify({ chunk: assistantReply })}\n\n`);
      // 发送完成信号
      res.write(
        `data: ${JSON.stringify({ done: true, conversation_id: convId, message_id: assistantMsg.message_id })}\n\n`,
      );
      clearInterval(keepAlive);
      res.end();
      return;
    }

    // 获取最近的对话历史（最多 10 条），按时间顺序（老 -> 新）作为上下文
    const history = await db.getConversationMessages(convId, 10);
    const messages = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    // 将当前用户输入追加到 messages 末尾
    messages.push({ role: "user", content });
    // 设置 SSE 响应头
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // 立即发送 headers，避免被代理或框架缓冲
    if (res.flushHeaders) res.flushHeaders();
    // 发送初始事件以提示前端连接已建立
    res.write(
      `data: ${JSON.stringify({ started: true, conversation_id: convId })}\n\n`,
    );
    // 心跳，防止代理/浏览器超时（每15秒一条注释行）
    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch (e) {
        // ignore write errors
      }
    }, 15000);
    let fullResponse = "";
    try {
      await openaiService.getChatCompletionStream(
        messages,
        (chunk) => {
          fullResponse += chunk;
          // 发送 SSE 数据
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        },
        { temperature: 0.7, max_tokens: 2000 },
      );
      // 存储完整回复
      const assistantMsg = await db.addMessage(
        convId,
        "assistant",
        fullResponse,
      );
      // 发送完成信号
      res.write(
        `data: ${JSON.stringify({
          done: true,
          conversation_id: convId,
          message_id: assistantMsg.message_id,
        })}\n\n`,
      );
      clearInterval(keepAlive);
      res.end();
    } catch (aiError) {
      console.error("AI Stream Error:", aiError);
      res.write(
        `data: ${JSON.stringify({
          error: "AI service error",
        })}\n\n`,
      );
      clearInterval(keepAlive);
      res.end();
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    }
  }
});

// 获取会话列表（按 updated_at 排序，支持分页）
router.get("/", auth.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    let page = Number(req.query.page);
    if (isNaN(page) || page < 1) page = 1;

    let pageSize = Number(req.query.pageSize);
    if (isNaN(pageSize) || pageSize < 1) pageSize = 20;
    pageSize = Math.min(pageSize, 100);
    const result = await db.listConversations(userId, page, pageSize);
    res.json({ items: result.items, total: result.total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 获取单个对话的消息，按时间顺序排列。可选 ?limit=10 返回最近 N 条（按 time asc）
router.get("/:id/messages", auth.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const convId = req.params.id;
    const limit = req.query.limit ? Number(req.query.limit) : null;

    // 验证所有权
    const pool = db._pool();
    const [rows] = await pool.execute(
      "SELECT user_id FROM conversations WHERE conversation_id = ?",
      [convId],
    );
    if (!rows || rows.length === 0)
      return sendErr(res, 404, "conversation not found");
    if (rows[0].user_id !== userId) return sendErr(res, 403, "forbidden");

    const messages = await db.getMessages(convId, limit ? limit : null);
    res.json({ conversation_id: convId, messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 删除对话（级联删除消息）
router.delete("/:id", auth.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const convId = req.params.id;
    const ok = await db.deleteConversation(convId, userId);
    if (!ok) return sendErr(res, 404, "conversation not found or not owned");
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
