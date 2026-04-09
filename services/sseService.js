// SSE 服务相关的工具函数，提供初始化 SSE 连接、发送事件、保持连接活跃和清理资源等功能。
function initSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}
// writeEvent 函数用于向 SSE 客户端发送事件，事件数据会被 JSON.stringify 序列化后发送。
function writeEvent(res, type, payload = {}) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}
// startKeepAlive 函数会定期发送一个注释行（以冒号开头）来保持 SSE 连接活跃，防止被代理服务器或浏览器关闭。
function startKeepAlive(res, intervalMs = 15000) {
  return setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (error) {
      // Ignore keep-alive write failures after the stream is gone.
    }
  }, intervalMs);
}
// attachCloseCleanup 函数用于在请求或响应关闭时执行清理操作，确保资源得到正确释放。
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
