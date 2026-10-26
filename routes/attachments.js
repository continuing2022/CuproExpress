const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../utils/auth");
const { sendError, sendInternalError } = require("../utils/response");
const repo = require("../repositories/attachmentRepo");
const storage = require("../services/attachmentStorage");
const { parseFile, MAX_FILE_BYTES } = require("../services/attachmentParser");
const router = express.Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1 } }).single("file");

router.post("/", (req, res) => {
  upload(req, res, async (error) => {
    if (error) return sendError(res, 400, error.code === "LIMIT_FILE_SIZE" ? "文件不能超过 5 MB" : "上传失败，请每次上传一个文件");
    try {
      if (!req.file) return sendError(res, 400, "请选择文件");
      // Multipart filenames use latin1 by default; browsers send UTF-8 bytes.
      if (!/[^\u0000-\u00ff]/.test(req.file.originalname)) {
        const decoded = Buffer.from(req.file.originalname, "latin1").toString("utf8");
        if (!decoded.includes("\ufffd")) req.file.originalname = decoded;
      }
      const file = await parseFile(req.file);
      return res.status(201).json(await repo.create(req.user.id, file));
    } catch (error) {
      return error.statusCode ? sendError(res, error.statusCode, error.message) : sendInternalError(res, error);
    }
  });
});

router.get("/:id", async (req, res) => {
  try {
    const file = await repo.getOwned(req.params.id, req.user.id);
    if (!file) return sendError(res, 404, "附件不存在");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return res.send(await storage.get(file.object_key));
  } catch (error) { return sendInternalError(res, error); }
});

router.delete("/:id", async (req, res) => {
  try { await repo.removePending(req.params.id, req.user.id); return res.sendStatus(204); }
  catch (error) { return sendInternalError(res, error); }
});
module.exports = router;
