const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withCredentials } = require("../services/userCredentials");
const rag = require("../services/ragService");
const { abortable, abortError } = require("../utils/cancellation");

test("RAG cancellation reaches fetch and is not retried", async () => {
  const controller = new AbortController();
  let calls = 0, started, childSignal;
  const waiting = new Promise(resolve => { started = resolve; });
  const task = withCredentials({ dashscope: "test-owned-key" }, () => rag.retrieveContext({ query: "copper", signal: controller.signal, options: {
    fetchImpl: async (_, { signal }) => { calls++; childSignal = signal; started(); return abortable(new Promise(() => {}), signal); },
  } }));
  await waiting;
  controller.abort(abortError());
  await assert.rejects(task, error => error.name === "AbortError");
  assert.ok(childSignal.aborted);
  assert.equal(calls, 1);
});

test("RAG timeout covers response body and retry waits respect cancellation", async () => {
  await assert.rejects(withCredentials({ dashscope: "test-owned-key" }, () => rag.retrieveContext({ query: "copper", options: {
    timeoutMs: 20, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  } })), error => error.name === "AbortError");
  const controller = new AbortController();
  let calls = 0;
  const task = withCredentials({ dashscope: "test-owned-key" }, () => rag.retrieveContext({ query: "copper", signal: controller.signal, options: {
    retryDelayMs: 5000, fetchImpl: async () => { calls++; throw Object.assign(new Error("network"), { code: "ECONNREFUSED" }); },
  } }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(abortError());
  await assert.rejects(task);
  assert.equal(calls, 1);
});

test("web search forwards the request signal to Axios", async () => {
  const axios = require("axios");
  const original = axios.post, key = process.env.BOCHA_API_KEY;
  process.env.BOCHA_API_KEY = "test-search-key";
  const controller = new AbortController();
  axios.post = async (_, __, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(abortError());
    return abortable(new Promise(() => {}), options.signal);
  };
  try { await assert.rejects(require("../searchTool").retrieveContext({ query: "copper", signal: controller.signal })); }
  finally { axios.post = original; if (key === undefined) delete process.env.BOCHA_API_KEY; else process.env.BOCHA_API_KEY = key; }
});
