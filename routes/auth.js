const express = require("express");
const bcrypt = require("bcryptjs");
const { userRepo, tokenRepo } = require("../repositories");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  authMiddleware,
  adminOnly,
  requireSelfOrAdmin,
} = require("../utils/auth");
const { sendError, sendInternalError } = require("../utils/response");
const {
  clearRefreshTokenCookie,
  readRefreshToken,
  setRefreshTokenCookie,
} = require("../utils/refreshTokenCookie");
const {
  isValidEmail,
  isValidUsername,
  isValidRole,
  normalizeEmail,
  normalizeUsername,
  validatePasswordLength,
  normalizePagination,
} = require("../utils/validators");
const { toPublicUser, toPublicUsers } = require("../utils/userMapper");

const router = express.Router();

function sendValidationError(res, fieldErrors) {
  return sendError(res, 400, "validation failed", {
    fieldErrors,
    errors: fieldErrors,
  });
}

router.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username);
    const { password } = req.body;
    const fieldErrors = {};

    if (!username) {
      fieldErrors.username = "username required";
    } else if (!isValidUsername(username)) {
      fieldErrors.username = "username must be 2-20 characters";
    }
    if (!email) {
      fieldErrors.email = "email required";
    } else if (!isValidEmail(email)) {
      fieldErrors.email = "invalid email format";
    }
    if (!password) {
      fieldErrors.password = "password required";
    } else if (!validatePasswordLength(password)) {
      fieldErrors.password = "password must be at least 6 characters";
    }
    if (Object.keys(fieldErrors).length > 0) {
      return sendValidationError(res, fieldErrors);
    }
    if (await userRepo.getUserByEmail(email)) {
      return sendError(res, 409, "email already registered");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await userRepo.createUser({
      email,
      username,
      password: hashedPassword,
      role: "user",
    });

    return res.status(201).json({ user: toPublicUser(user) });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body;
    const fieldErrors = {};

    if (!email) {
      fieldErrors.email = "email required";
    } else if (!isValidEmail(email)) {
      fieldErrors.email = "invalid email format";
    }
    if (!password) {
      fieldErrors.password = "password required";
    } else if (!validatePasswordLength(password)) {
      fieldErrors.password = "password must be at least 6 characters";
    }
    if (Object.keys(fieldErrors).length > 0) {
      return sendValidationError(res, fieldErrors);
    }

    const user = await userRepo.getUserByEmail(email);
    if (!user) {
      return sendError(res, 404, "email not registered");
    }

    await userRepo.updateUser(user.id, {
      password: await bcrypt.hash(password, 10),
    });
    await tokenRepo.revokeRefreshTokensByUserId(user.id);

    return res.json({ message: "password reset successfully" });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body;
    const rememberMe = req.body?.rememberMe !== false;
    const fieldErrors = {};

    if (!email) {
      fieldErrors.email = "email required";
    } else if (!isValidEmail(email)) {
      fieldErrors.email = "invalid email format";
    }
    if (!password) {
      fieldErrors.password = "password required";
    }
    if (Object.keys(fieldErrors).length > 0) {
      return sendValidationError(res, fieldErrors);
    }

    const user = await userRepo.getUserByEmail(email);
    if (!user) {
      return sendError(res, 401, "invalid credentials");
    }

    const matched = await bcrypt.compare(password, user.password);
    if (!matched) {
      return sendError(res, 401, "invalid credentials");
    }

    // 同步登录观测字段，便于后续统计与审计。
    await userRepo.updateUserLoginInfo(user.id);
    // accessToken 用于接口鉴权，refreshToken 用于长会话续期。
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await tokenRepo.saveRefreshToken({
      userId: user.id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    // 登录成功后即设置 HttpOnly 的 refresh token cookie
    setRefreshTokenCookie(res, refreshToken, { rememberMe });
    return res.json({
      token: { accessToken },
      user: toPublicUser(user),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post("/refresh", async (req, res) => {
  const refreshToken = readRefreshToken(req);
  if (!refreshToken) {
    return sendError(res, 401, "refresh token required");
  }

  try {
    // 刷新流程必须同时通过两层校验：
    // 1) JWT 签名与过期校验
    // 2) 服务端 token 记录未被撤销
    const payload = verifyRefreshToken(refreshToken);
    const stored = await tokenRepo.getRefreshToken(refreshToken);
    if (!stored || stored.revoked) {
      return sendError(res, 401, "invalid refresh token");
    }
    const expiresAtMs = stored.expires_at
      ? new Date(stored.expires_at).getTime()
      : 0;
    if (!expiresAtMs || expiresAtMs <= Date.now()) {
      await tokenRepo.revokeRefreshToken(refreshToken);
      return sendError(res, 401, "refresh token expired");
    }

    const user = await userRepo.getUserById(payload.id);
    if (!user) {
      return sendError(res, 401, "invalid refresh token");
    }

    const nextAccessToken = signAccessToken(user);
    const nextRefreshToken = signRefreshToken(user);

    await tokenRepo.revokeRefreshToken(refreshToken);
    await tokenRepo.saveRefreshToken({
      userId: user.id,
      token: nextRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    setRefreshTokenCookie(res, nextRefreshToken);

    return res.json({
      accessToken: nextAccessToken,
    });
  } catch (error) {
    clearRefreshTokenCookie(res);
    return sendError(res, 401, "refresh token expired");
  }
});

router.post("/logout", async (req, res) => {
  try {
    const refreshToken = readRefreshToken(req);
    if (refreshToken) {
      await tokenRepo.revokeRefreshToken(refreshToken);
    }
    clearRefreshTokenCookie(res);
    return res.json({ message: "logged out" });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.get("/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { search, role } = req.query;
    const { page, pageSize } = normalizePagination(req.query, {
      page: 1,
      pageSize: 10,
      maxPageSize: 100,
    });
    const offset = (page - 1) * pageSize;

    const filters = {};
    if (search) filters.search = search;
    if (role) filters.role = role;

    const users = await userRepo.getUsers({
      ...filters,
      offset,
      limit: pageSize,
    });
    const total = await userRepo.getUsersCount(filters);

    // 统一映射为公开 DTO，避免内部字段泄漏。
    return res.json({
      users: toPublicUsers(users),
      total,
      page,
      pageSize,
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.get("/users/stats", authMiddleware, adminOnly, async (req, res) => {
  try {
    const stats = await userRepo.getUserStats();
    return res.json(stats);
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.get(
  "/users/:id",
  authMiddleware,
  requireSelfOrAdmin,
  async (req, res) => {
    try {
      const user = await userRepo.getUserById(Number(req.params.id));
      if (!user) return sendError(res, 404, "user not found");
      return res.json(toPublicUser(user));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

router.post("/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username);
    const { password, role = "user" } = req.body;
    const fieldErrors = {};

    if (!username) {
      fieldErrors.username = "username required";
    } else if (!isValidUsername(username)) {
      fieldErrors.username = "username must be 2-20 characters";
    }
    if (!email) {
      fieldErrors.email = "email required";
    } else if (!isValidEmail(email)) {
      fieldErrors.email = "invalid email format";
    }
    if (!password) {
      fieldErrors.password = "password required";
    } else if (!validatePasswordLength(password)) {
      fieldErrors.password = "password must be at least 6 characters";
    }
    if (!isValidRole(role)) {
      return sendError(res, 400, "invalid role");
    }
    if (Object.keys(fieldErrors).length > 0) {
      return sendValidationError(res, fieldErrors);
    }
    if (await userRepo.getUserByEmail(email)) {
      return sendError(res, 409, "email already registered");
    }

    const user = await userRepo.createUser({
      email,
      username,
      password: await bcrypt.hash(password, 10),
      role,
    });

    return res.status(201).json(toPublicUser(user));
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.put("/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { username, email, role } = req.body;
    const user = await userRepo.getUserById(userId);
    if (!user) {
      return sendError(res, 404, "user not found");
    }

    const updates = {};
    if (username !== undefined) {
      const normalizedUsername = normalizeUsername(username);
      if (!normalizedUsername) {
        return sendValidationError(res, {
          username: "username required",
        });
      }
      if (!isValidUsername(normalizedUsername)) {
        return sendValidationError(res, {
          username: "username must be 2-20 characters",
        });
      }
      updates.username = normalizedUsername;
    }
    if (email !== undefined) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail) {
        return sendValidationError(res, {
          email: "email required",
        });
      }
      if (!isValidEmail(normalizedEmail)) {
        return sendValidationError(res, {
          email: "invalid email format",
        });
      }
      const existingUser = await userRepo.getUserByEmail(normalizedEmail);
      if (existingUser && existingUser.id !== userId) {
        return sendError(res, 409, "email already in use");
      }
      updates.email = normalizedEmail;
    }
    if (role !== undefined) {
      if (!isValidRole(role)) {
        return sendError(res, 400, "invalid role");
      }
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, "no fields to update");
    }

    const updatedUser = await userRepo.updateUser(userId, updates);
    return res.json(toPublicUser(updatedUser));
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.delete("/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (req.user.id === userId) {
      return sendError(res, 403, "cannot delete yourself");
    }

    const user = await userRepo.getUserById(userId);
    if (!user) {
      return sendError(res, 404, "user not found");
    }

    await userRepo.deleteUser(userId);
    return res.json({ message: "user deleted successfully" });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post(
  "/users/bulk-delete",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { userIds } = req.body;
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return sendError(res, 400, "userIds array required");
      }
      if (userIds.includes(req.user.id)) {
        return sendError(res, 403, "cannot delete yourself");
      }

      const deletedCount = await userRepo.deleteUsers(userIds);
      return res.json({
        message: "users deleted successfully",
        deletedCount,
      });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

router.put(
  "/users/:id/password",
  authMiddleware,
  requireSelfOrAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const { currentPassword, newPassword } = req.body;

      if (!newPassword) {
        return sendError(res, 400, "new password required");
      }
      if (!validatePasswordLength(newPassword)) {
        return sendError(res, 400, "password must be at least 6 characters");
      }

      const user = await userRepo.getUserById(userId);
      if (!user) {
        return sendError(res, 404, "user not found");
      }

      // 普通用户需校验旧密码；管理员可直接重置。
      if (req.user.role !== "admin") {
        if (!currentPassword) {
          return sendError(res, 400, "current password required");
        }
        const matched = await bcrypt.compare(currentPassword, user.password);
        if (!matched) {
          return sendError(res, 401, "current password incorrect");
        }
      }

      await userRepo.updateUser(userId, {
        password: await bcrypt.hash(newPassword, 10),
      });
      return res.json({ message: "password updated successfully" });
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

router.post("/users/export", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userIds } = req.body;
    const users =
      userIds && Array.isArray(userIds) && userIds.length > 0
        ? await userRepo.getUsersByIds(userIds)
        : await userRepo.getUsers({ offset: 0, limit: 10000 });

    return res.json({
      data: toPublicUsers(users),
      count: users.length,
      exportedAt: new Date().toISOString(),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await userRepo.getUserById(req.user.id);
    if (!user) return sendError(res, 404, "user not found");
    return res.json(toPublicUser(user));
  } catch (error) {
    return sendInternalError(res, error);
  }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminOnly = adminOnly;
