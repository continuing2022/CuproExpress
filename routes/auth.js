const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

const sendErr = (res, status, msg) => res.status(status).json({ error: msg });

// 注册接口 - 默认注册为普通用户
router.post("/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return sendErr(res, 400, "email, username and password required");
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendErr(res, 400, "invalid email format");
    }

    // 验证密码长度
    if (password.length < 6) {
      return sendErr(res, 400, "password must be at least 6 characters");
    }

    if (await db.getUserByEmail(email)) {
      return sendErr(res, 409, "email already registered");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await db.createUser({
      email,
      username,
      password: hashedPassword,
      role: "user", // 默认角色为普通用户
    });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "8h",
    });
    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 登录接口
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendErr(res, 400, "email and password required");
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      return sendErr(res, 401, "invalid credentials");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return sendErr(res, 401, "invalid credentials");
    }

    // 更新最后登录时间和登录次数
    await db.updateUserLoginInfo(user.id);

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "8h",
    });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// ==================== 用户管理接口 ====================

// 获取所有用户列表（仅管理员）
router.get("/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { search, role, page = 1, pageSize = 10 } = req.query;

    const filters = {};
    if (search) filters.search = search;
    if (role) filters.role = role;

    const offset = (page - 1) * pageSize;
    const limit = parseInt(pageSize);

    const users = await db.getUsers({ ...filters, offset, limit });
    const total = await db.getUsersCount(filters);

    // 移除密码字段
    const sanitizedUsers = users.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      loginCount: user.login_count,
    }));

    res.json({
      users: sanitizedUsers,
      total,
      page: parseInt(page),
      pageSize: limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 获取用户统计信息（仅管理员）
router.get("/users/stats", authMiddleware, adminOnly, async (req, res) => {
  try {
    const stats = await db.getUserStats();
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 获取单个用户详情（仅管理员或本人）
router.get("/users/:id", authMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // 只有管理员或用户本人可以查看
    if (req.user.role !== "admin" && req.user.id !== userId) {
      return sendErr(res, 403, "permission denied");
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return sendErr(res, 404, "user not found");
    }

    // 移除密码字段
    const sanitizedUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      loginCount: user.login_count,
    };

    res.json(sanitizedUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 添加用户（仅管理员）
router.post("/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { email, username, password, role = "user" } = req.body;

    if (!email || !username || !password) {
      return sendErr(res, 400, "email, username and password required");
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return sendErr(res, 400, "invalid email format");
    }

    // 验证密码长度
    if (password.length < 6) {
      return sendErr(res, 400, "password must be at least 6 characters");
    }

    // 验证角色
    if (!["user", "admin"].includes(role)) {
      return sendErr(res, 400, "invalid role");
    }

    if (await db.getUserByEmail(email)) {
      return sendErr(res, 409, "email already registered");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await db.createUser({
      email,
      username,
      password: hashedPassword,
      role,
    });

    res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 更新用户信息（仅管理员）
router.put("/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { username, email, role } = req.body;

    const user = await db.getUserById(userId);
    if (!user) {
      return sendErr(res, 404, "user not found");
    }

    const updates = {};
    if (username !== undefined) updates.username = username;
    if (email !== undefined) {
      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return sendErr(res, 400, "invalid email format");
      }

      // 检查邮箱是否已被其他用户使用
      const existingUser = await db.getUserByEmail(email);
      if (existingUser && existingUser.id !== userId) {
        return sendErr(res, 409, "email already in use");
      }
      updates.email = email;
    }
    if (role !== undefined) {
      if (!["user", "admin"].includes(role)) {
        return sendErr(res, 400, "invalid role");
      }
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return sendErr(res, 400, "no fields to update");
    }

    const updatedUser = await db.updateUser(userId, updates);

    res.json({
      id: updatedUser.id,
      username: updatedUser.username,
      email: updatedUser.email,
      role: updatedUser.role,
      createdAt: updatedUser.created_at,
      lastLogin: updatedUser.last_login,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 删除用户（仅管理员）
router.delete("/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // 不能删除自己
    if (req.user.id === userId) {
      return sendErr(res, 403, "cannot delete yourself");
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return sendErr(res, 404, "user not found");
    }

    await db.deleteUser(userId);

    res.json({ message: "user deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 批量删除用户（仅管理员）
router.post(
  "/users/bulk-delete",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { userIds } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return sendErr(res, 400, "userIds array required");
      }

      // 不能删除自己
      if (userIds.includes(req.user.id)) {
        return sendErr(res, 403, "cannot delete yourself");
      }

      const deletedCount = await db.deleteUsers(userIds);

      res.json({
        message: "users deleted successfully",
        deletedCount,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "internal error" });
    }
  },
);

// 修改密码（用户本人或管理员）
router.put("/users/:id/password", authMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { currentPassword, newPassword } = req.body;

    // 只有管理员或用户本人可以修改密码
    if (req.user.role !== "admin" && req.user.id !== userId) {
      return sendErr(res, 403, "permission denied");
    }

    if (!newPassword) {
      return sendErr(res, 400, "new password required");
    }

    if (newPassword.length < 6) {
      return sendErr(res, 400, "password must be at least 6 characters");
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return sendErr(res, 404, "user not found");
    }

    // 如果不是管理员，需要验证当前密码
    if (req.user.role !== "admin") {
      if (!currentPassword) {
        return sendErr(res, 400, "current password required");
      }
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match) {
        return sendErr(res, 401, "current password incorrect");
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.updateUser(userId, { password: hashedPassword });

    res.json({ message: "password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 导出用户数据（仅管理员）
router.post("/users/export", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userIds } = req.body;

    let users;
    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      // 导出指定用户
      users = await db.getUsersByIds(userIds);
    } else {
      // 导出所有用户
      users = await db.getUsers({ offset: 0, limit: 10000 });
    }

    // 移除敏感信息
    const exportData = users.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      loginCount: user.login_count,
    }));

    res.json({
      data: exportData,
      count: exportData.length,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

// 获取当前登录用户信息
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return sendErr(res, 404, "user not found");
    }

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      loginCount: user.login_count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;

// JWT 验证中间件，解码后将用户信息写入 req.user
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "token required" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

// 管理员权限中间件
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "admin access required" });
  }
  next();
}

module.exports.authMiddleware = authMiddleware;
module.exports.adminOnly = adminOnly;
