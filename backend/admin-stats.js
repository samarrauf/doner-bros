// Doner Bros — owner dashboard API: sales figures and AI Order Taker chats. Every route is behind
// an owner session (requireOwner, auth.js), except the kitchen board's live feed, which a kitchen
// session may read too (requireKitchen). Checked on the server: 401 signed out, 403 wrong role.
// Dates are "YYYY-MM-DD" Asia/Karachi days; with none given, the range is today in Karachi.

const path = require("path");

function addAdminStatsRoutes(app, { requireOwner, requireKitchen, requireDatabase, analytics, conversations, adminDir, getKitchenSettings, getDeliveryEta = async () => null }) {
  const guard = [requireOwner, requireDatabase];

  // The owner dashboard page itself.
  app.get("/admin/dashboard", requireOwner, (req, res) => res.sendFile(path.join(adminDir, "dashboard.html")));

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
  // The kitchen board's feed: open orders plus its amber/red thresholds and the delivery time for
  // the "on the way" message (each null if not set).
  app.get("/api/admin/orders/live", requireKitchen, requireDatabase, route("live orders", async () => {
    const [live, thresholds, deliveryEta] = await Promise.all([
      analytics.getLiveOrders(), getKitchenSettings().catch(() => null), getDeliveryEta().catch(() => null)]);
    return { ...live, thresholds, deliveryEta };
  }));

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
