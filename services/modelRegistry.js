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
};

function getClientForModel(modelName) {
  const config = MODEL_REGISTRY[modelName];
  if (!config) throw new Error(`不支持的模型: ${modelName}`);

  return {
    client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
    model: modelName,
  };
}

module.exports = { MODEL_REGISTRY, getClientForModel };
