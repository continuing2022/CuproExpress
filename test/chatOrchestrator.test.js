const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const runnerPath = path.resolve(
  __dirname,
  "../services/langchainAgentRunner.js",
);
const orchestratorPath = path.resolve(
  __dirname,
  "../services/chatOrchestrator.js",
);

test("chat orchestrator rethrows model runner failures", async () => {
  delete require.cache[orchestratorPath];
  delete require.cache[runnerPath];

  require.cache[runnerPath] = {
    id: runnerPath,
    filename: runnerPath,
    loaded: true,
    exports: {
      run: async () => {
        throw new Error("runner failed");
      },
    },
  };

  const chatOrchestrator = require(orchestratorPath);
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      () =>
        chatOrchestrator.run({
          conversationId: "conv-1",
          content: "hello",
          model: "qwen-plus",
          networkConfig: {},
        }),
      /runner failed/,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("chat orchestrator returns normalized telemetry on success", async () => {
  delete require.cache[orchestratorPath];
  delete require.cache[runnerPath];

  require.cache[runnerPath] = {
    id: runnerPath,
    filename: runnerPath,
    loaded: true,
    exports: {
      run: async () => ({
        fullResponse: "ok",
        mode: "direct_chat",
        retrievalMeta: { source: "unit-test" },
        diagnostics: {
          estimatedInputTokens: 12,
          summaryUsed: true,
          recentMessageCount: 2,
        },
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          prompt_tokens_details: {
            cached_tokens: 0,
          },
        },
      }),
    },
  };

  const chatOrchestrator = require(orchestratorPath);
  const result = await chatOrchestrator.run({
    conversationId: "conv-2",
    content: "hello",
    model: "qwen-plus",
    networkConfig: {},
  });

  assert.equal(result.fullResponse, "ok");
  assert.equal(result.mode, "direct_chat");
  assert.equal(result.retrievalMeta.source, "unit-test");
  assert.equal(result.telemetry.actual_prompt_tokens, 5);
  assert.equal(result.telemetry.completion_tokens, 7);
});
