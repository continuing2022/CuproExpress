const test = require("node:test");
const assert = require("node:assert/strict");

const {
  initSse,
  writeEvent,
  startKeepAlive,
} = require("../services/sseService");

test("initSse sets stream-safe headers", () => {
  const headers = {};
  let flushed = false;
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
    flushHeaders() {
      flushed = true;
    },
  };

  initSse(res);

  assert.equal(headers["Content-Type"], "text/event-stream");
  assert.equal(headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(headers.Connection, "keep-alive");
  assert.equal(headers["X-Accel-Buffering"], "no");
  assert.equal(flushed, true);
});

test("writeEvent serializes SSE payloads", () => {
  let written = "";
  const res = {
    write(chunk) {
      written += chunk;
    },
  };

  writeEvent(res, "chunk", { chunk: "hello" });

  assert.equal(written, 'data: {"type":"chunk","chunk":"hello"}\n\n');
});

test("startKeepAlive writes comment frames", async () => {
  const chunks = [];
  const res = {
    write(chunk) {
      chunks.push(chunk);
    },
  };

  const timer = startKeepAlive(res, 5);
  await new Promise((resolve) => setTimeout(resolve, 12));
  clearInterval(timer);

  assert.ok(chunks.some((chunk) => chunk.includes(": keep-alive")));
});
