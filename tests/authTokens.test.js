const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.JWT_SECRET = "auth-access-test";
process.env.REFRESH_SECRET = "auth-refresh-test";
const jwt = require("jsonwebtoken");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../utils/auth");
const { parseCookieHeader, readRefreshToken, REFRESH_TOKEN_COOKIE_NAME } = require("../utils/refreshTokenCookie");

test("access lives 15 minutes; same-second refresh tokens have distinct random jti", () => {
  const user = { id: 1, role: "user", session_version: 2 };
  const access = jwt.decode(signAccessToken(user));
  assert.equal(access.exp - access.iat, 15 * 60);
  const tokens = Array.from({ length: 20 }, () => signRefreshToken(user));
  assert.equal(new Set(tokens).size, 20);
  for (const token of tokens) {
    const payload = verifyRefreshToken(token);
    assert.match(payload.jti, /^[a-f0-9-]{36}$/);
    assert.equal(payload.sv, 2);
    assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
  }
});

test("malformed and prototype cookies cannot throw or hide a valid refresh cookie", () => {
  const cookies = parseCookieHeader(`bad=%E0%A4%A; __proto__=x; ${REFRESH_TOKEN_COOKIE_NAME}=valid%2Etoken`);
  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies[REFRESH_TOKEN_COOKIE_NAME], "valid.token");
  assert.equal(readRefreshToken({ headers: { cookie: `${REFRESH_TOKEN_COOKIE_NAME}=%E0%A4%A` } }), "");
  assert.equal(readRefreshToken({ body: { refreshToken: " legacy " } }), "legacy");
});
