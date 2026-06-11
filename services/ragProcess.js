const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_RAG_URL = "http://localhost:8001/rag/retrieve";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

let ragChild = null;
let startupPromise = null;

function getRagServiceUrl(env = process.env) {
  return env.RAG_SERVICE_URL || DEFAULT_RAG_URL;
}

function parseRagUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isLocalRagUrl(rawUrl) {
  const parsed = parseRagUrl(rawUrl);
  return Boolean(parsed && LOCAL_HOSTS.has(parsed.hostname));
}

function shouldAutoStartRag(env = process.env) {
  if (String(env.RAG_AUTO_START || "1").trim() === "0") return false;
  return isLocalRagUrl(getRagServiceUrl(env));
}

function isBlackholeProxy(value) {
  if (!value) return false;
  const parsed = parseRagUrl(String(value).trim());
  return Boolean(
    parsed &&
      LOCAL_HOSTS.has(parsed.hostname) &&
      String(parsed.port || "") === "9",
  );
}

function buildRagChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const name of PROXY_ENV_NAMES) {
    if (isBlackholeProxy(childEnv[name])) {
      delete childEnv[name];
    }
  }
  return childEnv;
}

function resolveRagPythonPath(env = process.env) {
  return (
    env.RAG_PYTHON_PATH ||
    path.join(__dirname, "..", ".venv", "Scripts", "python.exe")
  );
}

function resolveRagHostAndPort(rawUrl) {
  const parsed = parseRagUrl(rawUrl) || parseRagUrl(DEFAULT_RAG_URL);
  const host = parsed?.hostname === "localhost" ? "127.0.0.1" : parsed?.hostname;
  const port =
    Number(parsed?.port) || (parsed?.protocol === "https:" ? 443 : 80);
  return { host: host || "127.0.0.1", port };
}

function isPortOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    function done(open) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function startLocalRagIfNeeded(options = {}) {
  const env = options.env || process.env;
  if (!shouldAutoStartRag(env)) return null;
  if (ragChild && !ragChild.killed) return ragChild;
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    const ragUrl = getRagServiceUrl(env);
    const { host, port } = resolveRagHostAndPort(ragUrl);
    if (await isPortOpen(host, port, options.portCheckTimeoutMs)) {
      return null;
    }

    const pythonPath = resolveRagPythonPath(env);
    const cwd = path.join(__dirname, "..");
    const child = spawn(
      pythonPath,
      ["-m", "uvicorn", "main:app", "--host", host, "--port", String(port)],
      {
        cwd,
        env: buildRagChildEnv(env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    ragChild = child;
    child.stdout.on("data", (data) => {
      process.stdout.write(`[rag] ${data}`);
    });
    child.stderr.on("data", (data) => {
      process.stderr.write(`[rag] ${data}`);
    });
    child.once("exit", (code, signal) => {
      if (ragChild === child) ragChild = null;
      if (code && code !== 0) {
        console.error(`RAG service exited with code ${code}${signal ? ` (${signal})` : ""}`);
      }
    });

    return child;
  })();

  try {
    return await startupPromise;
  } finally {
    startupPromise = null;
  }
}

function stopLocalRagForTest() {
  if (ragChild && !ragChild.killed) {
    ragChild.kill();
  }
  ragChild = null;
  startupPromise = null;
}

process.once("exit", () => {
  if (ragChild && !ragChild.killed) {
    ragChild.kill();
  }
});

module.exports = {
  buildRagChildEnv,
  getRagServiceUrl,
  isBlackholeProxy,
  isLocalRagUrl,
  shouldAutoStartRag,
  startLocalRagIfNeeded,
  stopLocalRagForTest,
};
