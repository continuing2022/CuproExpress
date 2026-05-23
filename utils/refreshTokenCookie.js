const { getEnv } = require("./env");

const REFRESH_TOKEN_COOKIE_NAME = "cupro_refresh_token";
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookieHeader(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, pair) => {
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex < 0) return accumulator;
      const key = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      if (!key) return accumulator;
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function readRefreshToken(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie || "");
  const cookieToken = cookies[REFRESH_TOKEN_COOKIE_NAME];
  if (cookieToken) {
    return cookieToken;
  }

  const bodyToken = req?.body?.refreshToken;
  return typeof bodyToken === "string" ? bodyToken.trim() : "";
}

function shouldUseSecureCookie() {
  return getEnv("COOKIE_SECURE", "false").toLowerCase() === "true";
}

function setRefreshTokenCookie(res, token, options = {}) {
  const rememberMe = options.rememberMe !== false;
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/auth",
    maxAge: rememberMe ? REFRESH_TOKEN_MAX_AGE_MS : undefined,
  });
}

function clearRefreshTokenCookie(res) {
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/auth",
  });
}

module.exports = {
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_MAX_AGE_MS,
  parseCookieHeader,
  readRefreshToken,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
};
