const jwt = require("jsonwebtoken");
const { sendError } = require("./response");
const { requireEnv } = require("./env");

const ACCESS_SECRET = requireEnv("JWT_SECRET");
const REFRESH_SECRET = requireEnv("REFRESH_SECRET");

function signAccessToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, ACCESS_SECRET, {
    expiresIn: "8h",
  });
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id }, REFRESH_SECRET, {
    expiresIn: "7d",
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return sendError(res, 401, "token required");

  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    req.user = { id: payload.id, role: payload.role };
    return next();
  } catch (error) {
    return sendError(res, 401, "invalid token");
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return sendError(res, 403, "admin access required");
  }
  return next();
}

function requireSelfOrAdmin(req, res, next) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return sendError(res, 400, "invalid user id");
  }
  if (req.user?.role === "admin" || req.user?.id === userId) {
    return next();
  }
  return sendError(res, 403, "permission denied");
}

module.exports = {
  ACCESS_SECRET,
  REFRESH_SECRET,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  authMiddleware,
  adminOnly,
  requireSelfOrAdmin,
};
