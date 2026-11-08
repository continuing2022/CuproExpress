const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MemorySaver } = require("@langchain/langgraph");
const { BaseChatModel } = require("@langchain/core/language_models/chat_models");
const { AIMessage } = require("langchain");

process.env.LANGCHAIN_HISTORY_LIMIT = "8";
process.env.LANGCHAIN_SUMMARY_TRIGGER_TOKENS = "1000";
process.env.LANGCHAIN_SUMMARY_KEEP_MESSAGES = "4";

const primaryInputs = [];
const summaryInputs = [];
let failSummary = false;
class RecordingModel extends BaseChatModel {
  _llmType() { return "recording"; }
  bindTools() { return this; }
  async _generate(messages) {
    primaryInputs.push(messages.filter(message => message.type !== "system"));
    return { generations: [{ text: "answer", message: new AIMessage("answer") }] };
  }
}

const registry = require("../services/modelRegistry");
registry.getLangChainModelForName = (_, options) => options.streaming
  ? new RecordingModel({})
  : { async invoke(prompt) {
    summaryInputs.push(prompt);
    if (failSummary) throw new Error("summary unavailable");
    return new AIMessage("verified summary");
  } };

const { conversationRepo, conversationStateRepo } = require("../repositories");
require("../repositories/attachmentRepo").forMessages = async () => [];
const { run } = require("../services/langchainAgentRunner");

test("cold recovery uses recent history and persists the actual compacted boundary", async t => {
  const messages = Array.from({ length: 11 }, (_, index) => ({
    message_id: index + 1,
    role: index % 2 ? "assistant" : "user",
    status: index === 7 ? "aborted" : "done",
    content: `Message-${index + 1}: ${"word ".repeat(220)}`,
  }));
  let state = { running_summary: "legacy summary", last_summarized_message_id: 9, summary_version: 2 };
  t.mock.method(conversationStateRepo, "ensureConversationState", async () => state);
  t.mock.method(conversationStateRepo, "updateConversationSummary", async update => {
    assert.equal(update.summaryVersion, state.summary_version);
    state = {
      running_summary: update.runningSummary,
      last_summarized_message_id: update.lastSummarizedMessageId,
      summary_boundary_verified: true,
      summary_version: update.summaryVersion + 1,
    };
    return true;
  });
  const queries = [];
  t.mock.method(conversationRepo, "getMessagesAfter", async (_, after, options) => {
    assert.equal(options.forRecovery, true);
    queries.push(after);
    return messages.filter(message => message.message_id > after &&
      message.message_id < options.beforeMessageId && message.status === "done").slice(-options.limit);
  });
  let checkpointer;
  const put = MemorySaver.prototype.put;
  t.mock.method(MemorySaver.prototype, "put", function (...args) {
    checkpointer = this;
    return put.apply(this, args);
  });

  const input = { conversationId: "history", model: "qwen-plus", content: "latest question",
    pendingMessageId: 11, assistantMessageId: 12 };
  await run(input);
  assert.deepEqual(queries, [0]);
  assert.equal(state.last_summarized_message_id, 6);
  assert.match(summaryInputs[0], /Message-6:/);
  assert.doesNotMatch(summaryInputs[0], /Message-[178]:|legacy summary/);
  assert.deepEqual(primaryInputs[0].map(message => message.additional_kwargs.history_message_id),
    [undefined, 7, 9, 10, 11]);
  const tuples = await checkpointer.getTuple({ configurable: { thread_id: "history" } });
  assert.equal(tuples.checkpoint.channel_values.messages.at(-1).additional_kwargs.history_message_id, 12);

  await checkpointer.deleteThread("history");
  failSummary = true;
  await run({ ...input, content: "latest question ".repeat(200) });
  assert.equal(summaryInputs.length, 2);
  assert.deepEqual(queries, [0, 6]);
  assert.equal(state.summary_version, 3);
  assert.deepEqual(primaryInputs[1].map(message => message.additional_kwargs.history_message_id),
    [undefined, 7, 9, 10, 11]);
  assert.match(primaryInputs[1][0].content, /verified summary/);
});
