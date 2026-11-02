// SSE 服务相关的工具函数，提供初始化 SSE 连接、发送事件、保持连接活跃和清理资源等功能。
function initSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}
// A single bounded queue serializes data and heartbeats. Producers await drain
// so slow clients cannot make model chunks accumulate without a limit.
function createSseWriter(res, { signal, onFailure, maxPendingBytes = 1024 * 1024, drainTimeoutMs = 15000, keepAliveMs = 15000 } = {}) {
  const externalSignal = signal;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (externalSignal?.aborted) forwardAbort();
  signal = controller.signal;
  let tail = Promise.resolve(), pendingBytes = 0, failure = null, disposed = false;
  function fail(error) {
    if (!failure) { failure = error; if (!disposed) onFailure?.(error); }
    return error;
  }
  function write(frame) {
    const bytes = Buffer.byteLength(frame);
    if (pendingBytes + bytes > maxPendingBytes) {
      const rejected = Promise.reject(fail(new Error("SSE output queue exceeded")));
      rejected.catch(() => {});
      return rejected;
    }
    pendingBytes += bytes;
    const task = tail.then(async () => {
      if (failure) throw failure;
      signal?.throwIfAborted();
      if (disposed || res.destroyed || res.writableEnded) throw new Error("SSE connection closed");
      if (res.write(frame)) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          res.removeListener("drain", onDrain);
          res.removeListener("close", onClose);
          res.removeListener("error", onError);
          signal?.removeEventListener("abort", onAbort);
        };
        const done = error => { cleanup(); error ? reject(error) : resolve(); };
        const onDrain = () => done();
        const onClose = () => done(new Error("SSE connection closed"));
        const onError = error => done(error);
        const onAbort = () => done(signal.reason);
        const timer = setTimeout(() => done(new Error("SSE client drain timed out")), drainTimeoutMs);
        res.once("drain", onDrain);
        res.once("close", onClose);
        res.once("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else if (res.destroyed) onClose();
        else if (!res.writableNeedDrain) onDrain();
      });
    }).catch(error => { throw fail(error); }).finally(() => { pendingBytes -= bytes; });
    tail = task;
    task.catch(() => {});
    return task;
  }
  const heartbeat = setInterval(() => {
    if (!disposed && !pendingBytes && !failure) void write(": keep-alive\n\n");
  }, keepAliveMs);
  heartbeat.unref?.();
  return {
    event(type, payload = {}) { return write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); },
    flush() { return tail; },
    dispose() {
      disposed = true;
      clearInterval(heartbeat);
      controller.abort(new Error("SSE writer disposed"));
      externalSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

module.exports = { initSse, createSseWriter };
