const nodemailer = require("nodemailer");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

let transporter;

function configuration() {
  const production = process.env.NODE_ENV === "production";
  const mode = process.env.MAIL_TRANSPORT || "smtp";
  if (!["smtp", "json"].includes(mode) || (production && mode !== "smtp")) {
    throw new Error("Invalid password reset mail transport");
  }
  const url = new URL(process.env.PASSWORD_RESET_URL || (production ? "" : "http://localhost:5173/login"));
  if (url.username || url.password || (production ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))) {
    throw new Error("Invalid password reset URL");
  }
  if (mode === "smtp" && (!process.env.SMTP_HOST || !process.env.MAIL_FROM)) {
    throw new Error("Password reset SMTP is not configured");
  }
  return { mode, url };
}

async function send({ email, token }) {
  const { mode, url } = configuration();
  url.hash = `reset-token=${token}`;
  if (!transporter) {
    transporter = nodemailer.createTransport(mode === "json" ? { jsonTransport: true } : {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      requireTLS: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
    });
  }
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || "CuproAgent <dev@localhost>",
    to: email,
    subject: "CuproAgent 密码重置 / Password reset",
    text: `请在 15 分钟内打开链接设置新密码。链接仅可使用一次。如非本人操作，请忽略此邮件。\nOpen this one-time link within 15 minutes to reset your password:\n${url.href}`,
  });
  if (mode === "json") {
    const directory = path.join(__dirname, "../.local-mail");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${randomUUID()}.json`), info.message, { mode: 0o600 });
  }
}

module.exports = { configuration, send };
