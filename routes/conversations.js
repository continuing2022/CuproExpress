const express = require("express");
const db = require("../db");
const auth = require("./auth");

const router = express.Router();

const sendErr = (res, status, msg) => res.status(status).json({ error: msg });

// 开始新对话或在已有对话中继续发送消息
router.post("/", auth.authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversation_id, title, content } = req.body;
    if (!content) return sendErr(res, 400, "content required");
    let convId = conversation_id;
    // 如果没有 conversation_id，则创建新对话
    if (!convId) {
      const autoTitle =
        title || (content.length > 60 ? content.slice(0, 60) : content);
      const conv = await db.createConversation(userId, autoTitle);
      convId = conv.conversation_id;
    } else {
      // 验证用户对该会话的所有权
      const pool = db._pool();
      const [rows] = await pool.execute(
        "SELECT user_id FROM conversations WHERE conversation_id = ?",
        [convId],
      );
      if (!rows || rows.length === 0)
        return sendErr(res, 404, "conversation not found");
      if (rows[0].user_id !== userId) return sendErr(res, 403, "forbidden");
    }

    // 存储用户消息
    await db.addMessage(convId, "user", content);

    // TODO: 在此处调用 AI 接口（例如 OpenAI）并将回复存入 messages 表。
    // 当前实现为简单回显示例；可按需替换为真实 AI 调用。
    const assistantReply = `已收到: ${content.slice(0, 500)}`;
    const assistantMsg = await db.addMessage(
      convId,
      "assistant",
      assistantReply,
    );

    res.status(201).json({ conversation_id: convId, assistant: assistantMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
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
