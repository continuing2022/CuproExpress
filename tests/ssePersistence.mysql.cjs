const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
require("dotenv").config();
const mysql = require("mysql2/promise");
const host = process.env.DB_HOST || "localhost";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Local MySQL required");
const database = `cupro_sse_test_${randomBytes(8).toString("hex")}`;
process.env.DB_NAME = database;
let admin, pool;
(async () => {
  try {
    admin = await mysql.createConnection({ host, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectTimeout: 5000 });
    pool = await require("../db/pool").getPool();
    const { userRepo, conversationRepo } = require("../repositories");
    const service = require("../services/conversationService");
    const user = await userRepo.createUser({ email: "sse@example.com", username: "sse-test", password: "unused" });
    const conversation = await conversationRepo.createConversation(user.id, "SSE test");
    const id = conversation.conversation_id;
    await pool.execute("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', 'legacy message')", [id]);
    assert.equal((await conversationRepo.getMessages(id))[0].status, "done");
    for (const status of ["done", "error", "aborted", "timeout"]) {
      const message = await service.addAssistantMessage(id, "", { status: "streaming" });
      assert.equal((await conversationRepo.getMessages(id)).at(-1).status, "streaming");
      await service.updateAssistantMessage(message.message_id, `partial-${status}`, status);
      const saved = (await conversationRepo.getMessages(id)).at(-1);
      assert.equal(saved.message_id, message.message_id);
      assert.equal(saved.content, `partial-${status}`);
      assert.equal(saved.status, status);
      assert.equal((await conversationRepo.getMessagesAfter(id, message.message_id - 1))[0].status, status);
    }
    assert.equal((await conversationRepo.getMessages(id)).length, 5);
    console.log("MySQL SSE persistence passed: status migration/default, streaming placeholder, all terminal states, partial content and history queries.");
  } finally {
    await pool?.end();
    if (admin) {
      assert.match(database, /^cupro_sse_test_[a-f0-9]{16}$/);
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    }
  }
})().catch(error => { console.error("MySQL SSE persistence failed:", error.code || error.message); process.exitCode = 1; });
