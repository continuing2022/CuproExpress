require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRouter = require("./routes/auth");
const conversationsRouter = require("./routes/conversations");
const { startLocalRagIfNeeded } = require("./services/ragProcess");

function readAllowedOrigins() {
  const configured = String(
    process.env.CORS_ORIGINS ||
      "http://localhost:5173,http://127.0.0.1:5173",
  );

  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createApp() {
  const app = express();
  const allowedOrigins = new Set(readAllowedOrigins());
  const corsOptions = {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
  app.use(express.json());

  app.get("/", (req, res) => {
    res.send("Hello from OrangeExpress!");
  });

  app.use("/auth", authRouter);
  app.use("/conversations", conversationsRouter);

  return app;
}

function startServer(port = process.env.PORT || 3000) {
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
  startLocalRagIfNeeded().catch((error) => {
    console.error("Failed to start local RAG service:", error);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
};
