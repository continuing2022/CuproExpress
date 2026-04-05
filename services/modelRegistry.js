const OpenAI = require("openai");

const MODEL_REGISTRY = {
  "qwen-plus": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  "qwen-math-turbo": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  "qwen-max": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  "kimi-k2.5": {
    provider: "moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
  },
};

function assertSupportedModel(modelName) {
  const config = MODEL_REGISTRY[modelName];
  if (!config) {
    throw new Error(`unsupported model: ${modelName}`);
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `missing API key for model ${modelName}; expected env ${config.apiKeyEnv}`,
    );
  }

  return { ...config, apiKey };
}

function getClientForModel(modelName = "qwen-plus") {
  const config = assertSupportedModel(modelName);
  return {
    client: new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    }),
    model: modelName,
  };
}

module.exports = {
  MODEL_REGISTRY,
  assertSupportedModel,
  getClientForModel,
};
