const { test } = require("node:test");
const assert = require("node:assert/strict");
const poolModule = require("../db/pool");
let execute;
const calls = [];
const connection = {
  async beginTransaction() { calls.push("begin"); },
  async commit() { calls.push("commit"); },
  async rollback() { calls.push("rollback"); },
  release() { calls.push("release"); },
  async execute(sql, params) { calls.push(sql); return execute(sql, params); },
};
poolModule.getPool = async () => ({ getConnection: async () => connection, execute: async (sql, params) => { calls.push(sql); return execute(sql, params); } });
poolModule.ready = Promise.resolve();
const repo = require("../repositories/attachmentRepo");
const conversations = require("../repositories/conversationRepo");
const storage = require("../services/attachmentStorage");
const { cleanupAttachments } = require("../services/attachmentCleanup");

test("attaching another user's file rolls back before inserting a message", async () => {
  calls.length = 0;
  execute = async () => [[]];
  await assert.rejects(repo.addUserMessage("conversation", 1, "question", ["foreign-file"]), /无权访问/);
  assert.ok(calls.includes("rollback"));
  assert.ok(!calls.some(sql => sql.startsWith("INSERT INTO messages")));
  assert.equal(calls.at(-1), "release");
});

test("database failure during attachment binding rolls back the message", async () => {
  calls.length = 0;
  execute = async sql => {
    if (sql.startsWith("SELECT attachment_id")) return [[{ attachment_id: "file" }]];
    if (sql.startsWith("INSERT INTO messages")) return [{ insertId: 42 }];
    if (sql.startsWith("UPDATE attachments")) throw new Error("database failure");
    return [{}];
  };
  await assert.rejects(repo.addUserMessage("conversation", 1, "question", ["file"]), /database failure/);
  assert.ok(calls.includes("rollback"));
  assert.ok(!calls.includes("commit"));
});

test("conversation deletion durably queues objects before cascading message deletion", async () => {
  calls.length = 0;
  execute = async sql => sql.startsWith("SELECT conversation_id") ? [[{ conversation_id: "conversation" }]] : [{}];
  assert.equal(await conversations.deleteConversation("conversation", 1), true);
  const queue = calls.findIndex(sql => sql.startsWith("INSERT IGNORE INTO attachment_cleanup"));
  const deletion = calls.findIndex(sql => sql.startsWith("DELETE FROM conversations"));
  assert.ok(queue > 0 && deletion > queue);
  assert.ok(calls.includes("commit"));
});

test("cloud cleanup failures keep queued objects for retry and allow other objects to clear", async () => {
  const pending = new Set(["failed-object", "successful-object"]);
  const removed = [];
  execute = async (sql, params) => {
    if (sql.startsWith("SELECT attachment_id")) return [[]];
    if (sql.startsWith("SELECT object_key")) return [[...pending].map(object_key => ({ object_key }))];
    if (sql.startsWith("DELETE FROM attachment_cleanup")) pending.delete(params[0]);
    return [{}];
  };
  storage.remove = async key => { if (key === "failed-object") throw new Error("OSS unavailable"); removed.push(key); };
  await cleanupAttachments();
  assert.deepEqual([...pending], ["failed-object"]);
  assert.deepEqual(removed, ["successful-object"]);
});
