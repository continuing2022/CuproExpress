const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { parseFile, MAX_FILE_BYTES } = require("../services/attachmentParser");
const { buildMessageContent, normalizeAttachmentIds } = require("../services/attachmentContent");

function pdf(text) {
  const stream = text ? `BT /F1 12 Tf 50 750 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(output.length); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = output.length;
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGncAAAAASUVORK5CYII=", "base64");
const file = (name, buffer) => ({ originalname: name, buffer });

test("extracts real PDF and DOCX text in isolated processes", async () => {
  const result = await parseFile(file("copper.pdf", pdf("Copper alloy C11000")));
  assert.match(result.text, /Copper alloy C11000/);
  const Zip = require("jszip");
  const zip = new Zip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>铜合金 C11000</w:t></w:r></w:p></w:body></w:document>');
  const docx = await parseFile(file("材料.docx", await zip.generateAsync({ type: "nodebuffer" })));
  assert.match(docx.text, /铜合金 C11000/);
});

test("rejects scan-only, corrupt, binary, oversized and unsupported files", async () => {
  await assert.rejects(parseFile(file("scan.pdf", pdf(""))), /未提取到文字/);
  await assert.rejects(parseFile(file("broken.docx", Buffer.from("not a zip"))), /解析失败/);
  await assert.rejects(parseFile(file("fake.png", Buffer.from("fake image"))), /扩展名不一致/);
  await assert.rejects(parseFile(file("old.doc", Buffer.from("legacy"))), /不支持/);
  await assert.rejects(parseFile(file("bad.md", Buffer.from([255, 0]))), /UTF-8/);
  await assert.rejects(parseFile(file("huge.txt", Buffer.alloc(MAX_FILE_BYTES + 1))), /5 MB/);
  await assert.rejects(parseFile(file("long.txt", Buffer.from("a".repeat(40001)))), /40000/);
  assert.equal((await parseFile(file("材料.md", Buffer.from("# 铜\n纯铜")))).text, "# 铜\n纯铜");
});

test("builds image blocks and bounded document context without changing text messages", () => {
  assert.equal(buildMessageContent("hello"), "hello");
  assert.deepEqual(normalizeAttachmentIds(undefined), []);
  assert.throws(() => normalizeAttachmentIds(["bad"]), /附件列表/);
  const id = randomUUID();
  assert.throws(() => normalizeAttachmentIds([id, id]), /附件列表/);
  const content = buildMessageContent("分析", [{ name: "铜.png", mimeType: "image/png", data: png }, { name: "材料.md", mimeType: "text/markdown", text: "C11000" }]);
  assert.match(content.find(block => block.type === "image_url").image_url.url, /^data:image\/png;base64,/);
  assert.match(content.at(-1).text, /C11000/);
  assert.throws(() => buildMessageContent("", [{ name: "large.md", mimeType: "text/markdown", text: "铜".repeat(12000) }]), /总量过大/);
});

// Stub only external boundaries: no cloud requests or real database writes in these tests.
process.env.JWT_SECRET = "attachment-test-secret";
require("../repositories/userRepo").getUserById = async id => ({ id, role: "user", session_version: 0 });
process.env.REFRESH_SECRET = "attachment-refresh-test-secret";
process.env.DASHSCOPE_API_KEY = "test-key";
process.env.DEEPSEEK_API_KEY = "test-key";
require("../repositories/userApiKeyRepo").load = async () => ({ dashscope: "user-dashscope-test-key", deepseek: "user-deepseek-test-key" });
process.env.OBSERVE_CHAT_METRICS = "0";
const repo = require("../repositories/attachmentRepo");
const storage = require("../services/attachmentStorage");
const service = require("../services/conversationService");
const orchestrator = require("../services/chatOrchestrator");
const { conversationRepo } = require("../repositories");
const records = new Map();
const objects = new Map();
let nextMessageId = 1;
let captured;
repo.create = async (userId, parsed) => {
  const id = randomUUID();
  const record = { ...parsed, id, userId, object_key: id, message_id: null };
  records.set(id, record);
  objects.set(id, parsed.data);
  return { id, name: parsed.name, mimeType: parsed.mimeType, size: parsed.size };
};
repo.getOwned = async (id, userId) => records.get(id)?.userId === userId ? records.get(id) : null;
repo.removePending = async (id, userId) => { if (records.get(id)?.userId === userId && !records.get(id).message_id) { objects.delete(id); records.delete(id); } };
repo.conversationHasImages = async () => false;
repo.conversationHasAttachments = async () => false;
repo.addUserMessage = async (conv, userId, content, ids) => {
  const message_id = nextMessageId++;
  ids.forEach(id => { records.get(id).message_id = message_id; });
  return { message_id };
};
repo.forMessages = async (ids) => [...records.values()].filter(item => ids.includes(item.message_id)).map(({ id, name, mimeType, size, message_id }) => ({ id, name, mimeType, size, message_id }));
storage.get = async key => objects.get(key);
service.ensureConversation = async () => ({ ok: true, conversationId: "test-conversation" });
service.addAssistantMessage = async () => ({ message_id: 99 });
service.updateAssistantMessage = async () => ({});
conversationRepo.assertConversationOwner = async (userId) => userId === 1 ? { ok: true } : { ok: false, status: 403, error: "forbidden" };
conversationRepo.getMessages = async () => [{ message_id: 1, role: "user", content: "" }];
conversationRepo.countMessagesAfter = async () => 0;
orchestrator.run = async (input) => { captured = input; input.onChunk("已分析附件"); return { fullResponse: "已分析附件", mode: "direct_chat" }; };
let server;
let base;
const jwt = require("jsonwebtoken");
const token = id => jwt.sign({ id }, process.env.JWT_SECRET);
const headers = id => ({ Authorization: `Bearer ${token(id)}` });
before(async () => {
  server = require("../index").createApp().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
async function upload(name, buffer, userId = 1) {
  const body = new FormData(); body.append("file", new Blob([buffer]), name);
  return fetch(`${base}/attachments`, { method: "POST", headers: headers(userId), body });
}
async function send(payload, userId = 1) {
  return fetch(`${base}/conversations`, { method: "POST", headers: { ...headers(userId), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

test("authenticated upload, private download, attachment-only model input and history", async () => {
  const uploaded = await upload("铜组织.png", png);
  assert.equal(uploaded.status, 201);
  const metadata = await uploaded.json();
  assert.equal(metadata.name, "铜组织.png");
  assert.equal((await fetch(`${base}/attachments/${metadata.id}`)).status, 401);
  assert.equal((await fetch(`${base}/attachments/${metadata.id}`, { headers: headers(2) })).status, 404);
  const download = await fetch(`${base}/attachments/${metadata.id}`, { headers: headers(1) });
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal((await send({ content: "", model: "qwen-plus", attachment_ids: [metadata.id] })).status, 400);
  assert.equal((await send({ content: "", model: "qwen3-vl-plus", attachment_ids: [metadata.id] }, 2)).status, 400);
  const sent = await send({ content: "", model: "qwen3-vl-plus", attachment_ids: [metadata.id] });
  assert.equal(sent.status, 200);
  const events = await sent.text();
  assert.match(events, /user_message_id/);
  assert.match(events, /已分析附件/);
  assert.equal(captured.content.find(block => block.type === "image_url").image_url.url, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal((await send({ model: "qwen3-vl-plus", attachment_ids: [metadata.id] })).status, 400);
  const history = await fetch(`${base}/conversations/test-conversation/messages`, { headers: headers(1) });
  assert.equal((await history.json()).messages[0].attachments[0].id, metadata.id);
  assert.equal((await fetch(`${base}/conversations/test-conversation/messages`, { headers: headers(2) })).status, 403);
});

test("upload constraints and pending-file removal are enforced at HTTP boundary", async () => {
  assert.equal((await upload("bad.exe", Buffer.from("MZ"))).status, 400);
  assert.equal((await upload("big.txt", Buffer.alloc(MAX_FILE_BYTES + 1))).status, 400);
  const result = await upload("notes.md", Buffer.from("# 铜材说明"));
  const item = await result.json();
  assert.equal((await send({ content: "分析文档", model: "deepseek-v4-pro", attachment_ids: [item.id] })).status, 400);
  await fetch(`${base}/attachments/${item.id}`, { method: "DELETE", headers: headers(2) });
  assert.ok(records.has(item.id));
  const removed = await fetch(`${base}/attachments/${item.id}`, { method: "DELETE", headers: headers(1) });
  assert.equal(removed.status, 204);
  assert.equal(records.has(item.id), false);
});

test("document text reaches the model and attachment history keeps the authorized provider", async () => {
  const item = await (await upload("copper.md", Buffer.from("C11000 copper"))).json();
  const sent = await send({ content: "分析文档", model: "qwen-plus", attachment_ids: [item.id] });
  assert.equal(sent.status, 200);
  await sent.text();
  assert.match(captured.content.at(-1).text, /C11000 copper/);
  repo.conversationHasAttachments = async () => true;
  assert.equal((await send({ conversation_id: "test-conversation", content: "继续", model: "deepseek-v4-pro" })).status, 400);
  repo.conversationHasAttachments = async () => false;
  repo.conversationHasImages = async () => true;
  assert.equal((await send({ conversation_id: "test-conversation", content: "继续", model: "qwen-plus" })).status, 400);
  repo.conversationHasImages = async () => false;
});
