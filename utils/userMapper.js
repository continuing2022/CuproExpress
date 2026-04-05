function toPublicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    lastLogin: user.last_login,
    loginCount: user.login_count,
  };
}

function toPublicUsers(users = []) {
  return users.map((user) => toPublicUser(user));
}

module.exports = {
  toPublicUser,
  toPublicUsers,
};
