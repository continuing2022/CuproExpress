require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRouter = require("./routes/auth");

const app = express();
// enable CORS for all routes
app.use(cors());
app.options("*", cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello from OrangeExpress!");
});

app.use("/auth", authRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
