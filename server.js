// Vercel entry point: Vercel runs the Express app exported from server.js at the project root.
// The app and all its routes live in backend/server.js; locally, run that (npm start in /backend).
require("express"); // Vercel recognises the app as Express by this file importing it
module.exports = require("./backend/server");
