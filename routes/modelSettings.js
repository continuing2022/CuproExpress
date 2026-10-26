const express = require("express");
const { authMiddleware } = require("../utils/auth");
const { sendError, sendInternalError } = require("../utils/response");
const repo = require("../repositories/userApiKeyRepo");
const router = express.Router();
router.use(authMiddleware);
router.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

function handleError(res, error) {
  return error.statusCode ? sendError(res, error.statusCode, error.message, { code: error.code }) : sendInternalError(res, error);
}

router.get("/", async (req, res) => {
  try { res.json({ providers: await repo.list(req.user.id) }); }
  catch (error) { handleError(res, error); }
});
router.put("/:provider", async (req, res) => {
  try {
    await repo.save(req.user.id, req.params.provider, req.body.apiKey);
    res.json({ message: "API Key 已保存" });
  } catch (error) { handleError(res, error); }
});
router.delete("/:provider", async (req, res) => {
  try {
    await repo.remove(req.user.id, req.params.provider);
    res.json({ message: "API Key 已删除" });
  } catch (error) { handleError(res, error); }
});
module.exports = router;
