const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = ["user", "admin"];

function isValidEmail(email) {
  return EMAIL_REGEX.test(String(email || ""));
}

function isValidRole(role) {
  return ALLOWED_ROLES.includes(role);
}

function validatePasswordLength(password, min = 6) {
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
  isValidEmail,
  isValidRole,
  validatePasswordLength,
  normalizePagination,
};
