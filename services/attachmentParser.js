const { fork } = require("node:child_process");
const path = require("node:path");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".pdf": "application/pdf",
  ".md": "text/markdown", ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function parseFile(file) {
  const name = path.basename(String(file.originalname || "").replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255);
  const extension = path.extname(name).toLowerCase();
  const mimeType = TYPES[extension];
  const data = file.buffer;
  if (!mimeType) throw invalid("不支持此文件类型，请上传 PNG、JPEG、WebP、PDF、MD、TXT 或 Word (.docx)");
  if (!data?.length || data.length > MAX_FILE_BYTES) throw invalid("文件不能为空，且不能超过 5 MB");
  const signatures = {
    "image/png": () => data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    "image/jpeg": () => data[0] === 255 && data[1] === 216 && data[2] === 255,
    "image/webp": () => data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP",
    "application/pdf": () => data.toString("ascii", 0, 5) === "%PDF-",
  };
  if (signatures[mimeType] && !signatures[mimeType]()) throw invalid("文件内容与扩展名不一致");
  let text = "";
  if (extension === ".md" || extension === ".txt") {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { throw invalid("文本文件需要使用 UTF-8 编码"); }
    if (text.includes("\0")) throw invalid("文件不是有效的文本文件");
  } else if (!mimeType.startsWith("image/")) {
    text = await extractInProcess(data, extension);
  }
  if (!mimeType.startsWith("image/")) {
    text = text.trim();
    if (!text) throw invalid("未提取到文字；扫描版 PDF 请先进行 OCR，或将页面作为图片上传");
    if (text.length > 40000) throw invalid("文档文字超过 40000 字符，请拆分后上传");
  }
  return { name, mimeType, size: data.length, data, text };
}

function extractInProcess(data, extension) {
  return new Promise((resolve, reject) => {
    const worker = fork(__filename, [], {
      execArgv: ["--max-old-space-size=256"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timer = setTimeout(() => {
      worker.kill();
      reject(invalid("文档解析超时，请拆分文件后重试"));
    }, 15000);
    worker.once("message", (result) => {
      clearTimeout(timer);
      if (result.error) reject(invalid("文档解析失败，请确认文件未损坏、未加密且为 PDF 或 .docx"));
      else resolve(result.text);
      worker.kill();
    });
    worker.once("error", () => { clearTimeout(timer); reject(invalid("文档解析失败，请检查文件或缩小文件大小")); });
    worker.once("exit", () => { clearTimeout(timer); reject(invalid("文档解析失败")); });
    worker.send({ data, extension }, error => { if (error) { clearTimeout(timer); worker.kill(); reject(invalid("文档解析失败")); } });
  });
}

if (require.main === module && process.send) process.once("message", (workerData) => {
  (async () => {
    const buffer = Buffer.from(workerData.data);
    if (workerData.extension === ".pdf") {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try { return (await parser.getText({ pageJoiner: "\n" })).text; }
      finally { await parser.destroy(); }
    }
    return (await require("mammoth").extractRawText({ buffer })).value;
  })().then((text) => process.send({ text }), () => process.send({ error: true }));
});

module.exports = { parseFile, invalid, MAX_FILE_BYTES, MAX_ATTACHMENTS };
