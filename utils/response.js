function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, message, ...extra });
}

function sendInternalError(res, error) {
  return sendError(res, 500, "internal error");
}

module.exports = {
  sendError,
  sendInternalError,
};
