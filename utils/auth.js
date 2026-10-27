const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { sendError } = require("./response");
const { requireEnv } = require("./env");

const ACCESS_SECRET = requireEnv("JWT_SECRET");
const REFRESH_SECRET = requireEnv("REFRESH_SECRET");

function signAccessToken(user) {
  return jwt.sign({ id: user.id, role: user.role, sv: user.session_version || 0 }, ACCESS_SECRET, {
    expiresIn: "15m",
  });
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id, sv: user.session_version || 0 }, REFRESH_SECRET, {
    expiresIn: "7d",
    jwtid: randomUUID(),
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return sendError(res, 401, "token required");

  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { maxAge: "15m" });
    const user = await require("../repositories/userRepo").getUserById(payload.id);
    if (!user || (payload.sv ?? 0) !== (user.session_version || 0)) {
      return sendError(res, 401, "invalid token");
    }
    req.user = { id: user.id, role: user.role };
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
