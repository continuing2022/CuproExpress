const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = ["user", "admin"];
const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 20;
const PASSWORD_MIN_LENGTH = 6;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function isValidEmail(email) {
  return EMAIL_REGEX.test(normalizeEmail(email));
}

function isValidUsername(username) {
  const normalized = normalizeUsername(username);
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH
  );
}

function isValidRole(role) {
  return ALLOWED_ROLES.includes(role);
}

function validatePasswordLength(password, min = PASSWORD_MIN_LENGTH) {
  return typeof password === "string" && password.length >= min;
}

function normalizePagination({ page, pageSize }, defaults = {}) {
  const safePage = Math.max(1, Number(page) || defaults.page || 1);
  const maxPageSize = defaults.maxPageSize || 100;
  const safePageSize = Math.min(
    maxPageSize,
    Math.max(1, Number(pageSize) || defaults.pageSize || 20),
  );

  return { page: safePage, pageSize: safePageSize };
}

module.exports = {
  ALLOWED_ROLES,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isValidEmail,
  isValidUsername,
  isValidRole,
  normalizeEmail,
  normalizeUsername,
  validatePasswordLength,
  normalizePagination,
};
