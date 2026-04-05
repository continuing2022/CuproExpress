const axios = require("axios");

const BOCHA_SEARCH_URL =
  process.env.BOCHA_SEARCH_URL || "https://api.bochaai.com/v1/web-search";

function getBochaApiKey() {
  return (process.env.BOCHA_API_KEY || "").trim();
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

async function retrieveContext({ query }) {
  const apiKey = getBochaApiKey();
  if (!apiKey) {
    return {
      mode: "direct_chat",
      contextText: "",
      meta: { fallbackFrom: "web_search", reason: "missing_bocha_api_key" },
    };
  }

  const response = await axios.post(
    BOCHA_SEARCH_URL,
    { query, count: 5 },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  const results = normalizeResults(response.data);
  const contextText = results
    .map((item, index) => {
      const title = item.title || `搜索结果 ${index + 1}`;
      const snippet = item.snippet || "";
      const url = item.url || "";
      return `${index + 1}. ${title}\n${snippet}\n来源: ${url}`;
    })
    .join("\n\n");

  return {
    mode: "web_search",
    contextText,
    meta: {
      resultCount: results.length,
    },
  };
}

module.exports = {
  retrieveContext,
  getBochaApiKey,
};
