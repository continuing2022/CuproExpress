const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, ".env") });

const BOCHA_SEARCH_URL = "https://api.bochaai.com/v1/web-search";

function getBochaApiKey() {
  return ("sk-eeecf7ada6d64dcc8f22170e4bd016cf" || "").trim();
}

function normalizeResults(payload) {
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.webPages?.value)) {
    return payload.data.webPages.value.map((item) => ({
      title: item.name,
      snippet: item.snippet,
      url: item.url,
    }));
  }
  return [];
}

async function webSearch(query) {
  const apiKey = getBochaApiKey();
  if (!apiKey) {
    console.warn("联网检索未启用：缺少 BOCHA_API_KEY，已跳过 Bocha 网络搜索。");
    return "";
  }

  try {
    const response = await axios.post(
      BOCHA_SEARCH_URL,
      {
        query: `请联网搜索并总结：${query}`,
        count: 5,
      },
      {
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    const results = normalizeResults(response.data);
    return results
      .map((item, index) => {
        const title = item.title || "未命名结果";
        const snippet = item.snippet || "无摘要";
        const url = item.url || "";
        return `${index + 1}. ${title}\n${snippet}\n来源: ${url}`;
      })
      .join("\n\n");
  } catch (error) {
    if (error?.response?.status === 401) {
      console.warn(
        "Bocha 网络搜索鉴权失败：请检查 CuproExpress/.env 中的 BOCHA_API_KEY 是否存在且有效。",
      );
      return "";
    }
    throw error;
  }
}

module.exports = {
  webSearch,
  getBochaApiKey,
};
