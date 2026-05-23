const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REFRESH_TOKEN_COOKIE_NAME,
  parseCookieHeader,
  readRefreshToken,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
} = require("../utils/refreshTokenCookie");

test("parseCookieHeader extracts cookie pairs", () => {
  const cookies = parseCookieHeader(
    "foo=bar; cupro_refresh_token=abc123; theme=light",
  );

  assert.equal(cookies.foo, "bar");
  assert.equal(cookies[REFRESH_TOKEN_COOKIE_NAME], "abc123");
  assert.equal(cookies.theme, "light");
});

test("readRefreshToken prefers cookie over request body", () => {
  const req = {
    headers: {
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=cookie-token`,
    },
    body: {
      refreshToken: "body-token",
    },
  };

  assert.equal(readRefreshToken(req), "cookie-token");
});

test("setRefreshTokenCookie configures an httpOnly auth cookie", () => {
  const calls = [];
  const res = {
    cookie(name, value, options) {
      calls.push({ name, value, options });
    },
  };

  setRefreshTokenCookie(res, "token-value", { rememberMe: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, REFRESH_TOKEN_COOKIE_NAME);
  assert.equal(calls[0].value, "token-value");
  assert.equal(calls[0].options.httpOnly, true);
  assert.equal(calls[0].options.sameSite, "lax");
  assert.equal(calls[0].options.path, "/auth");
});

test("clearRefreshTokenCookie clears the auth cookie", () => {
  const calls = [];
  const res = {
    clearCookie(name, options) {
      calls.push({ name, options });
    },
  };

  clearRefreshTokenCookie(res);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, REFRESH_TOKEN_COOKIE_NAME);
  assert.equal(calls[0].options.httpOnly, true);
  assert.equal(calls[0].options.path, "/auth");
});
