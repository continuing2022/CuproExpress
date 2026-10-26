const OpenAI = require("openai");
const { ChatOpenAI } = require("@langchain/openai");
const { getRequestApiKey } = require("./userCredentials");

function createModelError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// 显式白名单：前端/路由传入的模型名必须在此注册。
const MODEL_REGISTRY = {
  "qwen3-vl-plus": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 262144,
    preferredOutputTokens: 4000,
    supportsVision: true,
  },
  "qwen-plus": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 131072,
    preferredOutputTokens: 4000,
  },
  "qwen-math-turbo": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 32768,
    preferredOutputTokens: 4000,
  },
  "qwen-flash": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 32768,
    preferredOutputTokens: 4000,
  },
  "qwen-max": {
    provider: "dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    contextWindow: 32768,
    preferredOutputTokens: 4000,
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    contextWindow: 128000,
    preferredOutputTokens: 4000,
  },
};
// 校验模型名，仅返回公共模型配置；凭据由当前请求提供。
function assertSupportedModel(modelName) {
  const config = Object.hasOwn(MODEL_REGISTRY, modelName) ? MODEL_REGISTRY[modelName] : null;
  if (!config) {
    throw createModelError(
      `unsupported model: ${modelName}`,
      400,
      "UNSUPPORTED_MODEL",
    );
  }

  return { ...config };
}
// 根据模型名获取对应的OpenAI客户端实例和模型配置
function getClientForModel(modelName = "qwen-plus") {
  const config = assertSupportedModel(modelName);
  return {
    client: new OpenAI({
      apiKey: getRequestApiKey(config.provider),
      baseURL: config.baseURL,
    }),
    model: modelName,
  };
}

function getLangChainModelForName(modelName = "qwen-plus", options = {}) {
  const config = assertSupportedModel(modelName);
  return new ChatOpenAI({
    ...options,
    model: modelName,
    apiKey: getRequestApiKey(config.provider),
    configuration: {
      baseURL: config.baseURL,
    },
  });
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
  createModelError,
  assertSupportedModel,
  getClientForModel,
  getLangChainModelForName,
  getModelMetadata,
};
