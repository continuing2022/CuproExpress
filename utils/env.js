function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function getEnv(name, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

module.exports = {
  requireEnv,
  getEnv,
};
