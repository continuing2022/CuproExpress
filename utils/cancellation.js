function abortError(message = "Request cancelled", code = "cancelled") {
  return Object.assign(new Error(message), { name: "AbortError", code });
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function createRequestScope(req, res) {
  const controller = new AbortController();
  const configured = Number(process.env.CHAT_DEADLINE_MS);
  const deadlineMs = Number.isFinite(configured) && configured > 0 ? configured : 120000;
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error("回答超时，请重试"), { name: "TimeoutError", code: "chat_timeout" })), deadlineMs);
  timeout.unref?.();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(abortError("Client disconnected"));
  };
  req.once("aborted", onClose);
  res.once("close", onClose);
  if (req.aborted || res.destroyed) onClose();
  return {
    controller,
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      req.removeListener("aborted", onClose);
      res.removeListener("close", onClose);
    },
  };
}

module.exports = { abortError, abortable, createRequestScope };
