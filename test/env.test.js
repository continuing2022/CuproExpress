const test = require("node:test");
const assert = require("node:assert/strict");

const { requireEnv, getEnv } = require("../utils/env");

test("requireEnv returns configured values", () => {
  process.env.TEST_REQUIRED_ENV = "configured";
  assert.equal(requireEnv("TEST_REQUIRED_ENV"), "configured");
  delete process.env.TEST_REQUIRED_ENV;
});

test("requireEnv throws when a variable is missing", () => {
  delete process.env.TEST_MISSING_ENV;
  assert.throws(
    () => requireEnv("TEST_MISSING_ENV"),
    /TEST_MISSING_ENV environment variable is required/,
  );
});

test("getEnv falls back when a variable is missing", () => {
  delete process.env.TEST_OPTIONAL_ENV;
  assert.equal(getEnv("TEST_OPTIONAL_ENV", "fallback"), "fallback");
});
