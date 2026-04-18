const OpenAI = require("openai");

// 显式白名单：前端/路由传入的模型名必须在此注册。
const MODEL_REGISTRY = {
  "qwen-plus": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    contextWindow: 131072,
    preferredOutputTokens: 4000,
  },
  "qwen-math-turbo": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    contextWindow: 32768,
    preferredOutputTokens: 4000,
  },
  "qwen-max": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    contextWindow: 32768,
    preferredOutputTokens: 4000,
  },
  "kimi-k2.5": {
    provider: "moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    contextWindow: 128000,
    preferredOutputTokens: 4000,
  },
};
// 校验模型名是否合法，并返回对应的模型配置（包含API Key）
function assertSupportedModel(modelName) {
  const config = MODEL_REGISTRY[modelName];
  if (!config) {
    throw new Error(`unsupported model: ${modelName}`);
  }

  // 每个模型绑定独立的环境变量名，运行时强制校验。
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `missing API key for model ${modelName}; expected env ${config.apiKeyEnv}`,
    );
  }

  return { ...config, apiKey };
}
// 根据模型名获取对应的OpenAI客户端实例和模型配置
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

function getModelMetadata(modelName = "qwen-plus") {
  const config = MODEL_REGISTRY[modelName] || MODEL_REGISTRY["qwen-plus"];
  return {
    name: modelName,
    contextWindow: Number(config.contextWindow) || 32768, // 上下文窗口大小
    preferredOutputTokens: Number(config.preferredOutputTokens) || 4000, // token预算中预留给输出的部分
  };
}

module.exports = {
  MODEL_REGISTRY,
  assertSupportedModel,
  getClientForModel,
  getModelMetadata,
};
