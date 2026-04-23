const { getPool, ready, testDbConnection } = require("./db/pool");
const {
  userRepo,
  conversationRepo,
  conversationStateRepo,
  tokenRepo,
} = require("./repositories");

testDbConnection().catch((error) => {
  console.error("database connection failed:", error);
  process.exit(1);
});

module.exports = {
  ...userRepo,
  ...conversationRepo,
  ...conversationStateRepo,
  ...tokenRepo,
  testDbConnection,
  ready,
  _pool: getPool,
  user: userRepo,
  conversation: conversationRepo,
  conversationState: conversationStateRepo,
  token: tokenRepo,
};
