const OpenAI = require("openai");
// modelRegistry.js - 模型注册中心
const MODEL_REGISTRY = {
  // 阿里云百炼
  "qwen-plus": {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
  },
  "qwen-math-turbo": {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
  },
  "qwen-max": {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
  },
  "kimi-k2.5": {
    baseURL: "https://api.moonshot.cn/v1",
    apiKey: process.env.KIMI_API_KEY,
  },
};

function getClientForModel(modelName) {
  const config = MODEL_REGISTRY[modelName];
  if (!config) throw new Error(`不支持的模型: ${modelName}`);

  // 明确检查是否配置了 API Key，避免后续抛出不明确的错误
  if (!config.apiKey) {
    throw new Error(
      `模型 ${modelName} 未配置 API Key，请在环境变量中设置对应的密钥（例如 process.env.KIMI_API_KEY）。`,
    );
  }

  return {
    client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
    model: modelName,
  };
}

module.exports = { MODEL_REGISTRY, getClientForModel };
