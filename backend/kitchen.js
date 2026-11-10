// Doner Bros — kitchen order board: the /admin/kitchen page and the one route it uses to change an
// order's status. Behind the staff password (requireStaff, checked on the server). The board reads
// its orders from /api/admin/orders/live (admin-stats.js).
//
// The database trigger in supabase/migrations/0004_kitchen.sql stamps the time of every change.

const path = require("path");
const { nextStatus } = require("./staff");

const ORDER_ID_PATTERN = /^DB-\d{8}-[A-HJ-NP-Z2-9]{6}$/;
const OPEN_STATUSES = ["NEW", "PREPARING", "READY"];
const PREVIOUS = { PREPARING: "NEW", READY: "PREPARING" };

// The moves the board may make: one step on, one step back, or cancel an open order.
function isAllowedMove(from, to) {
  if (!OPEN_STATUSES.includes(from)) return false;
  return to === nextStatus(from) || to === PREVIOUS[from] || to === "CANCELLED";
}

function addKitchenRoutes(app, { client, requireStaff, requireDatabase, adminDir }) {
  app.get("/admin/kitchen", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "kitchen.html")));
  // The board's alert rules (when to ring and remind), shared with the tests.
  app.get("/admin/kitchen-alerts.js", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "kitchen-alerts.js")));

  // Changes the status only if the order is still in the status the board showed, so two tablets
  // tapping at once can't skip or undo a step: the second gets 409 and the board refreshes.
  app.post("/api/admin/orders/:orderId/status", requireStaff, requireDatabase, async (req, res) => {
    const { orderId } = req.params;
    const { from, to } = req.body || {};
    if (!ORDER_ID_PATTERN.test(orderId)) return res.status(400).json({ error: "That isn't a valid order ID." });
    if (!isAllowedMove(from, to)) return res.status(400).json({ error: "That order can't be moved that way." });

    const { data, error } = await client
      .from("orders")
      .update({ status: to })
      .eq("order_id", orderId)
      .eq("status", from)
      .select("order_id, status")
      .maybeSingle();
    if (error) {
      console.error("Kitchen status update failed:", error.code || error.name);
      return res.status(502).json({ error: "Couldn't update the order. Try again." });
    }
    if (!data) return res.status(409).json({ error: "This order was already changed on another screen." });
    console.log(`Order ${orderId}: ${from} -> ${to} (kitchen).`);
    res.json({ order: data });
  });
}

module.exports = { isAllowedMove, addKitchenRoutes };
