const TOKEN_ESTIMATE_MULTIPLIER = Number(
  process.env.TOKEN_ESTIMATE_MULTIPLIER || 1.1,
);
// token估算
function estimateTextTokens(text = "") {
  const input = String(text || "");
  if (!input.trim()) return 0;

  const cjkMatches = input.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const asciiText = input.replace(
    /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g,
    "",
  );
  const asciiCount = asciiText.length;
  const whitespaceCount = (input.match(/\s/g) || []).length;
  const punctuationCount = (
    input.match(/[.,/#!$%^&*;:{}=\-_`~()"'?<>[\]\\|+]/g) || []
  ).length;

  const estimated =
    cjkCount * 1.15 +
    Math.max(0, asciiCount - whitespaceCount) / 4 +
    punctuationCount * 0.25 +
    4;

  return Math.max(1, Math.ceil(estimated * TOKEN_ESTIMATE_MULTIPLIER));
}

function estimateMessageTokens(message = {}) {
  return (
    4 +
    estimateTextTokens(message.role || "") +
    estimateTextTokens(message.content || "")
  );
}

function estimateMessagesTokens(messages = []) {
  return (messages || []).reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

function trimTextToTokenBudget(text = "", maxTokens = 0) {
  const normalized = String(text || "");
  if (!normalized.trim()) return "";
  if (!maxTokens || estimateTextTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const kept = [];
  let total = 0;

  for (const line of lines) {
    const next = estimateTextTokens(line);
    if (kept.length > 0 && total + next > maxTokens) break;
    if (kept.length === 0 && next > maxTokens) {
      return trimSingleLine(line, maxTokens);
    }
    kept.push(line);
    total += next;
  }

  const result = kept.join("\n").trim();
  if (!result) {
    return trimSingleLine(normalized, maxTokens);
  }
  return result;
}

function trimMessagesToTokenBudget(messages = [], maxTokens = 0) {
  if (!Array.isArray(messages) || messages.length === 0 || !maxTokens) {
    return Array.isArray(messages) ? [...messages] : [];
  }

  const kept = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const next = estimateMessageTokens(message);
    if (kept.length > 0 && total + next > maxTokens) break;
    if (kept.length === 0 && next > maxTokens) {
      kept.unshift({
        ...message,
        content: trimTextToTokenBudget(
          message.content,
          Math.max(32, maxTokens - 8),
        ),
      });
      break;
    }
    kept.unshift(message);
    total += next;
  }
  return kept;
}

function trimSingleLine(text, maxTokens) {
  if (!text || maxTokens <= 0) return "";
  let low = 0;
  let high = text.length;
  let best = "";

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, middle).trim()}...`;
    const candidateTokens = estimateTextTokens(candidate);
    if (candidateTokens <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best || text.slice(0, Math.max(1, Math.floor(text.length / 3))).trim();
}

module.exports = {
  estimateTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  trimTextToTokenBudget,
  trimMessagesToTokenBudget,
};
