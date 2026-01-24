const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

const sendErr = (res, status, msg) => res.status(status).json({ error: msg });

router.post("/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return sendErr(res, 400, "email, username and password required");
    }
    if (await db.getUserByEmail(email)) {
      return sendErr(res, 409, "email already registered");
    }
    if (await db.getUserByUsername(username)) {
      return sendErr(res, 409, "username already taken");
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await db.createUser({
      email,
      username,
      password: hashedPassword,
    });
    res.status(201).json({
      id: user.id,
      email: user.email,
      username: user.username,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

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
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "8h" });
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
