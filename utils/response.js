function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function sendInternalError(res, error) {
  console.error(error);
  return sendError(res, 500, "internal error");
}

module.exports = {
  sendError,
  sendInternalError,
};
