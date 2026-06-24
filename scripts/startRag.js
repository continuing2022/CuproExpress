const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { buildRagChildEnv } = require("../services/ragProcess");

const host = "127.0.0.1";
const port = 8001;
const healthUrl = `http://${host}:${port}/health`;

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(healthUrl, { timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }

        try {
          const payload = JSON.parse(body);
          resolve(payload.status === "ok");
        } catch {
          resolve(false);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function main() {
  if (await checkHealth()) {
    return;
  }

  const pythonPath =
    process.env.RAG_PYTHON_PATH ||
    path.join(__dirname, "..", ".venv", "Scripts", "python.exe");
  const child = spawn(
    pythonPath,
    ["-m", "uvicorn", "main:app", "--host", host, "--port", String(port)],
    {
      cwd: path.join(__dirname, ".."),
      env: buildRagChildEnv(process.env),
      stdio: "inherit",
      windowsHide: true,
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch(() => {
  process.exit(1);
});
