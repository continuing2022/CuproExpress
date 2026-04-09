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
  isValidEmail,
  isValidRole,
  validatePasswordLength,
  normalizePagination,
} = require("../utils/validators");
const { toPublicUser, toPublicUsers } = require("../utils/userMapper");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return sendError(res, 400, "email, username and password required");
    }
    if (!isValidEmail(email)) {
      return sendError(res, 400, "invalid email format");
    }
    if (!validatePasswordLength(password)) {
      return sendError(res, 400, "password must be at least 6 characters");
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

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 400, "email and password required");
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

    return res.json({
      token: { accessToken, refreshToken },
      user: toPublicUser(user),
    });
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
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

    const user = await userRepo.getUserById(payload.id);
    if (!user) {
      return sendError(res, 401, "invalid refresh token");
    }

    return res.json({ accessToken: signAccessToken(user) });
  } catch (error) {
    return sendError(res, 401, "refresh token expired");
  }
});

router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await tokenRepo.revokeRefreshToken(refreshToken);
    }
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

router.get("/users/:id", authMiddleware, requireSelfOrAdmin, async (req, res) => {
  try {
    const user = await userRepo.getUserById(Number(req.params.id));
    if (!user) return sendError(res, 404, "user not found");
    return res.json(toPublicUser(user));
  } catch (error) {
    return sendInternalError(res, error);
  }
});

router.post("/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { email, username, password, role = "user" } = req.body;

    if (!email || !username || !password) {
      return sendError(res, 400, "email, username and password required");
    }
    if (!isValidEmail(email)) {
      return sendError(res, 400, "invalid email format");
    }
    if (!validatePasswordLength(password)) {
      return sendError(res, 400, "password must be at least 6 characters");
    }
    if (!isValidRole(role)) {
      return sendError(res, 400, "invalid role");
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
    if (username !== undefined) updates.username = username;
    if (email !== undefined) {
      if (!isValidEmail(email)) {
        return sendError(res, 400, "invalid email format");
      }
      const existingUser = await userRepo.getUserByEmail(email);
      if (existingUser && existingUser.id !== userId) {
        return sendError(res, 409, "email already in use");
      }
      updates.email = email;
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

router.post("/users/bulk-delete", authMiddleware, adminOnly, async (req, res) => {
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
});

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
