const conversationService = require("./conversationService");
const orchestrator = require("./chatOrchestrator");
const { withCredentials } = require("./userCredentials");
const { initSse, createSseWriter } = require("./sseService");
const { abortable } = require("../utils/cancellation");

function publicError(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return "模型服务拒绝了你的 API Key，请在模型服务设置中检查密钥和权限";
  if (status === 402) return "模型服务余额不足，请检查你的服务商账户";
  if (status === 429) return "模型服务额度不足或请求过于频繁，请检查你的账户额度后重试";
  if (error?.code === "chat_timeout") return "回答超时，请重试";
  return "AI service error";
}

async function runConversationStream({ req, res, scope, userKeys, conversationId, userMessage, content, model, networkConfig, observer }) {
  const { signal, controller } = scope;
  let writer, terminalWriter, assistant, saved = false, fullResponse = "";
  const persist = async status => {
    if (!assistant || saved) return;
    await conversationService.updateAssistantMessage(assistant.message_id, fullResponse, status);
    saved = true;
  };
  try {
    signal.throwIfAborted();
    assistant = await conversationService.addAssistantMessage(conversationId, "", { status: "streaming" });
    signal.throwIfAborted();
    initSse(res);
    observer.markSseOpened();
    writer = createSseWriter(res, { signal, onFailure: error => controller.abort(error) });
    await writer.event("started", {
      started: true, conversation_id: conversationId,
      user_message_id: userMessage.message_id, assistant_message_id: assistant.message_id,
    });
    const result = await abortable(withCredentials(userKeys, () => orchestrator.run({
      conversationId, content, model, networkConfig,
      pendingMessageId: userMessage.message_id, observer, signal,
      async onRetrieved(retrieval) {
        if (signal.aborted) return;
        const meta = retrieval.meta || {};
        if (retrieval.mode !== "direct_chat" || Object.keys(meta).length) observer.markRetrieved({ mode: retrieval.mode, meta });
        await writer.event("retrieved", { retrieved: true, mode: retrieval.mode, meta, context_profile: retrieval.diagnostics?.contextProfile || {} });
      },
      async onChunk(chunk) {
        if (signal.aborted) return;
        const text = String(chunk || "");
        if (!text) return;
        observer.markFirstChunk(text);
        observer.markChunk(text);
        fullResponse += text;
        await writer.event("chunk", { chunk: text });
      },
    })), signal);
    signal.throwIfAborted();
    await writer.flush();
    if (!fullResponse) fullResponse = String(result.fullResponse || "");
    await persist("done");
    await writer.event("done", {
      done: true, status: "done", conversation_id: conversationId, message_id: assistant.message_id,
      mode: result.mode, meta: result.retrievalMeta, diagnostics: result.telemetry,
    });
    observer.finish({ fullResponse, mode: result.mode, retrievalMeta: result.retrievalMeta, telemetry: result.telemetry, assistantMessageId: assistant.message_id, streamClosedEarly: false });
  } catch (error) {
    if (!signal.aborted) controller.abort(error);
    const reason = signal.aborted ? signal.reason : error;
    const status = reason?.code === "chat_timeout" ? "timeout" : reason?.name === "AbortError" ? "aborted" : "error";
    writer?.dispose();
    await writer?.flush().catch(() => {});
    try { await persist(status); } catch {
      // A failed write remains visibly 'streaming' in storage for later repair.
      console.error("Failed to persist assistant terminal state");
    }
    if (status === "aborted") {
      observer.abort({ reason: "client_closed" });
      observer.finish({ fullResponse, streamClosedEarly: true, assistantMessageId: assistant?.message_id });
    } else observer.fail({ error: new Error(publicError(reason)), stage: "conversation_stream", streamClosedEarly: true });
    if (!res.headersSent) throw reason;
    if (!res.destroyed && !res.writableEnded) {
      // The generation signal may already be aborted. Use a separate, bounded
      // terminal write to report a deadline while the transport is still open.
      terminalWriter = createSseWriter(res, { drainTimeoutMs: 1000 });
      await terminalWriter.event(status === "aborted" ? "cancelled" : "error", {
        status, message_id: assistant?.message_id, error: publicError(reason),
      }).catch(() => res.destroy());
    }
  } finally {
    writer?.dispose();
    terminalWriter?.dispose();
    if (res.headersSent && !res.destroyed && !res.writableEnded) res.end();
  }
}

module.exports = { runConversationStream };
