function initSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function writeEvent(res, type, payload = {}) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function startKeepAlive(res, intervalMs = 15000) {
  return setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (error) {
      // Ignore keep-alive write failures after the stream is gone.
    }
  }, intervalMs);
}

function attachCloseCleanup(req, res, ...cleanups) {
  let cleaned = false;

  const runCleanups = () => {
    if (cleaned) return;
    cleaned = true;
    cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        // Ignore cleanup failures so stream shutdown can continue.
      }
    });
  };

  req.on("aborted", runCleanups);
  req.on("close", () => {
    if (req.aborted) {
      runCleanups();
    }
  });
  res.on("close", runCleanups);
}

module.exports = {
  initSse,
  writeEvent,
  startKeepAlive,
  attachCloseCleanup,
};
