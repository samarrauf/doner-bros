// Doner Bros — Express server: loads .env and serves the static frontend.

const path = require("path");
const dotenv = require("dotenv");
const express = require("express");

// .env lives in the project root, one level above /backend.
const envResult = dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });
if (envResult.error) {
  console.warn("No .env file found; using defaults. Copy .env.example to .env to configure.");
}

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

const app = express();

app.use(express.static(FRONTEND_DIR));

const server = app.listen(PORT, () => {
  console.log(`Doner Bros server running at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set a different PORT in .env.`);
  } else {
    console.error("Server failed to start:", error.message);
  }
  process.exit(1);
});
