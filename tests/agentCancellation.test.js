const { test } = require("node:test");
const assert = require("node:assert/strict");
const langchain = require("langchain");
const { abortable, abortError } = require("../utils/cancellation");
const registry = require("../services/modelRegistry");
registry.getLangChainModelForName = () => ({ invoke: async () => "summary" });
const { conversationRepo, conversationStateRepo } = require("../repositories");
conversationStateRepo.ensureConversationState = async () => ({});
conversationRepo.getMessagesAfter = async () => [];
let graphSignal, yielded = 0;
require.cache[require.resolve("langchain")].exports = {
  ...langchain,
  summarizationMiddleware: () => ({}),
  tool: fn => fn,
  createAgent: options => ({
    getState: async () => ({ values: { messages: [] } }),
    updateState: async () => {},
    async *stream(_, config) {
      graphSignal = config.signal;
      await options.tools[0]({ query: "copper" });
      yielded++;
      yield ["messages", [new langchain.AIMessageChunk({ content: "one" }), {}]];
      yielded++;
      yield ["messages", [new langchain.AIMessageChunk({ content: "two" }), {}]];
      yield ["values", { messages: [new langchain.AIMessage({ content: "onetwo" })] }];
    },
  }),
};
const rag = require("../services/ragService");
const runner = require("../services/langchainAgentRunner");

test("agent forwards signal to graph/tools and awaits output backpressure", async () => {
  const controller = new AbortController();
  rag.retrieveContext = async options => {
    assert.equal(options.signal, controller.signal);
    return { mode: "local_rag", contextText: "copper" };
  };
  let release, first;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { first = resolve; });
  yielded = 0;
  const run = runner.run({ conversationId: "backpressure", pendingMessageId: 1, content: "copper", model: "qwen-plus", signal: controller.signal,
    onChunk: async () => { first(); await gate; }, onRetrieved: async () => {},
  });
  await waiting;
  assert.equal(graphSignal, controller.signal);
  assert.equal(yielded, 1);
  release();
  assert.equal((await run).fullResponse, "onetwo");
});

test("cancelled retrieval propagates out of the agent instead of becoming a fallback", async () => {
  const controller = new AbortController();
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  rag.retrieveContext = async ({ signal }) => { started(); return abortable(new Promise(() => {}), signal); };
  let chunks = 0;
  const run = runner.run({ conversationId: "cancel", pendingMessageId: 1, content: "copper", model: "qwen-plus", signal: controller.signal, onChunk: () => chunks++ });
  await waiting;
  controller.abort(abortError());
  await assert.rejects(run, error => error.name === "AbortError");
  assert.equal(chunks, 0);
});
