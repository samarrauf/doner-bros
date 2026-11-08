// Doner Bros — owner dashboard API: sales figures and AI Order Taker chats. Every route is behind
// the staff password (requireStaff, checked on the server), so a request without it gets 401.
// Dates are "YYYY-MM-DD" Asia/Karachi days; with none given, the range is today in Karachi.

const path = require("path");

function addAdminStatsRoutes(app, { requireStaff, requireDatabase, analytics, conversations, adminDir }) {
  const guard = [requireStaff, requireDatabase];

  // The owner dashboard page itself.
  app.get("/admin/dashboard", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "dashboard.html")));

  // Runs read(req) and sends its JSON. A bad date range is the caller's fault (400).
  const route = (label, read) => async (req, res) => {
    try {
      const result = await read(req);
      if (result === null) return res.status(404).json({ error: "Not found." });
      res.json(result);
    } catch (error) {
      if (error.code === "BAD_RANGE") return res.status(400).json({ error: error.message });
      console.error(`Admin ${label} failed:`, error.code || error.message);
      res.status(502).json({ error: "Couldn't load that right now. Try again." });
    }
  };
  const q = (req, name) => (typeof req.query[name] === "string" && req.query[name] ? req.query[name] : undefined);

  app.get("/api/admin/stats/today", ...guard, route("today", () => analytics.getToday()));
  app.get("/api/admin/stats/month", ...guard, route("month", () => analytics.getMonth()));
  app.get("/api/admin/stats/range", ...guard, route("range", (req) => analytics.getRange(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/stats/comparison", ...guard, route("comparison", (req) => analytics.getComparison(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/stats/hourly", ...guard, route("hourly", (req) => analytics.getHourly(q(req, "from") || q(req, "date"), q(req, "to"))));
  app.get("/api/admin/stats/top-items", ...guard, route("top items", (req) => analytics.getTopItems(q(req, "from"), q(req, "to"), q(req, "limit"))));
  app.get("/api/admin/stats/deals", ...guard, route("deals", (req) => analytics.getDealPerformance(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/stats/customers", ...guard, route("customers", (req) => analytics.getRepeatCustomers(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/orders/live", ...guard, route("live orders", () => analytics.getLiveOrders()));

  // Fixed paths before /chats/:id.
  app.get("/api/admin/chats/live", ...guard, route("live chats", () => conversations.getLiveConversations()));
  app.get("/api/admin/chats/stats", ...guard, route("chat stats", (req) => conversations.getConversationStats(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/chats", ...guard, route("chats", (req) => conversations.getConversations(q(req, "from"), q(req, "to"))));
  app.get("/api/admin/chats/:id", ...guard, route("chat", (req) => conversations.getConversation(req.params.id)));

  app.get("/api/admin/stats/export.csv", ...guard, async (req, res) => {
    try {
      const { from, to, csv } = await analytics.exportCsv(q(req, "from"), q(req, "to"));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="doner-bros-orders-${from}-to-${to}.csv"`);
      res.send(csv);
    } catch (error) {
      if (error.code === "BAD_RANGE") return res.status(400).json({ error: error.message });
      console.error("Admin export failed:", error.code || error.message);
      res.status(502).json({ error: "Couldn't build the export right now. Try again." });
    }
  });
}

module.exports = { addAdminStatsRoutes };
