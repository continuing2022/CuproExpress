const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSseWriter } = require("../services/sseService");
const { abortError, abortable, createRequestScope } = require("../utils/cancellation");
const orchestrator = require("../services/chatOrchestrator");
const service = require("../services/conversationService");
const { runConversationStream } = require("../services/conversationStream");
const observer = new Proxy({}, { get: () => () => {} });
let server, base, saved, settled, signal;
service.addAssistantMessage = async () => ({ message_id: 9 });
service.updateAssistantMessage = async (id, content, status) => { saved = { id, content, status }; settled?.(); };
before(async () => {
  const app = require("express")();
  app.get("/:mode", async (req, res) => {
    const scope = createRequestScope(req, res);
    signal = scope.signal;
    try {
      await runConversationStream({ req, res, scope, userKeys: {}, conversationId: req.params.mode,
        userMessage: { message_id: 8 }, content: "question", model: "qwen-plus", networkConfig: {}, observer });
    } finally { scope.dispose(); }
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => new Promise(resolve => server.close(resolve)));

test("success emits one done and persists the complete response", async () => {
  orchestrator.run = async ({ onChunk, onRetrieved, signal }) => {
    assert.ok(!signal.aborted);
    await onRetrieved({ mode: "direct_chat" });
    await onChunk("one"); await onChunk("two");
    return { fullResponse: "onetwo" };
  };
  const text = await (await fetch(base + "/done")).text();
  assert.equal((text.match(/"type":"done"/g) || []).length, 1);
  assert.match(text, /assistant_message_id/);
  assert.deepEqual(saved, { id: 9, content: "onetwo", status: "done" });
});

test("upstream failure preserves partial text and hides credentials", async () => {
  orchestrator.run = async ({ onChunk }) => { await onChunk("partial"); throw new Error("sk-must-not-leak"); };
  const text = await (await fetch(base + "/error")).text();
  assert.match(text, /"type":"error"/);
  assert.ok(!text.includes("sk-must-not-leak") && !text.includes('"type":"done"'));
  assert.equal(saved.status, "error");
  assert.equal(saved.content, "partial");
});

test("deadline aborts upstream, reports timeout and preserves partial text", async () => {
  process.env.CHAT_DEADLINE_MS = "60";
  orchestrator.run = async ({ onChunk, signal }) => { await onChunk("partial"); await abortable(new Promise(() => {}), signal); };
  try {
    const text = await (await fetch(base + "/timeout")).text();
    assert.match(text, /"status":"timeout"/);
    assert.equal(saved.status, "timeout");
    assert.ok(signal.aborted);
  } finally { delete process.env.CHAT_DEADLINE_MS; }
});

test("disconnect aborts upstream and rejects late chunks", async () => {
  const persisted = new Promise(resolve => { settled = resolve; });
  let cancelled;
  orchestrator.run = async ({ onChunk, signal }) => {
    await onChunk("partial");
    try { await abortable(new Promise(() => {}), signal); } catch { cancelled = true; }
    await onChunk("must-not-save");
    return { fullResponse: "must-not-save" };
  };
  const controller = new AbortController();
  const response = await fetch(base + "/cancel", { signal: controller.signal });
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes('"type":"chunk"')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  await persisted;
  settled = undefined;
  assert.equal(saved.status, "aborted");
  assert.equal(saved.content, "partial");
  assert.ok(cancelled && signal.aborted);
});

class SlowResponse extends EventEmitter {
  frames = [];
  writableNeedDrain = true;
  write(frame) { this.frames.push(frame); return !this.writableNeedDrain; }
}

test("slow client blocks later events and heartbeat until drain", async () => {
  const res = new SlowResponse();
  const writer = createSseWriter(res, { keepAliveMs: 5 });
  try {
    const first = writer.event("chunk", { chunk: "a" });
    const second = writer.event("done");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(res.frames.length, 1);
    res.writableNeedDrain = false;
    res.emit("drain");
    await Promise.all([first, second]);
    assert.equal(res.frames.length, 2);
    assert.match(res.frames[1], /"done"/);
    assert.equal(res.listenerCount("drain"), 0);
  } finally { writer.dispose(); }
});

test("blocked writer cancels cleanly and enforces drain timeout and byte limit", async () => {
  const res = new SlowResponse(), controller = new AbortController();
  const writer = createSseWriter(res, { signal: controller.signal });
  const waiting = writer.event("chunk");
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(abortError());
  await assert.rejects(waiting);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
  writer.dispose();
  const limited = createSseWriter(new SlowResponse(), { maxPendingBytes: 10 });
  await assert.rejects(limited.event("chunk", { chunk: "too much" }), /queue exceeded/);
  limited.dispose();
  const timed = createSseWriter(new SlowResponse(), { drainTimeoutMs: 10 });
  await assert.rejects(timed.event("chunk"), /drain timed out/);
  timed.dispose();
});
