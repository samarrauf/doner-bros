// Doner Bros — kitchen order board: the /admin/kitchen page and the one route it uses to change an
// order's status. Behind a kitchen or owner session (requireKitchen from auth.js, checked on the server). The board reads
// its orders from /api/admin/orders/live (admin-stats.js).
//
// The database trigger in supabase/migrations/0004_kitchen.sql stamps the time of every change.

const path = require("path");
const { nextStatus } = require("./staff");
const { WHATSAPP_COLUMNS, whatsappForOrder } = require("./whatsapp-message");

const ORDER_ID_PATTERN = /^DB-\d{8}-[A-HJ-NP-Z2-9]{6}$/;
const OPEN_STATUSES = ["NEW", "PREPARING", "READY"];
const PREVIOUS = { PREPARING: "NEW", READY: "PREPARING" };

// The moves the board may make: one step on, one step back, or cancel an open order.
function isAllowedMove(from, to) {
  if (!OPEN_STATUSES.includes(from)) return false;
  return to === nextStatus(from) || to === PREVIOUS[from] || to === "CANCELLED";
}

// The WhatsApp message is offered once an order is READY (and still from "Send again" after that).
const WHATSAPP_STATUSES = ["READY", "COMPLETED"];

function addKitchenRoutes(app, { client, requireKitchen, requireDatabase, adminDir, getDeliveryEta = async () => null }) {
  const requireStaff = requireKitchen;
  app.get("/admin/kitchen", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "kitchen.html")));
  // The board's alert rules (when to ring and remind), shared with the tests.
  app.get("/admin/kitchen-alerts.js", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "kitchen-alerts.js")));
  // The WhatsApp pop-up's rules (phone format, link, queue), shared with the server and the tests.
  app.get("/admin/kitchen-whatsapp.js", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "kitchen-whatsapp.js")));

  // The "ready" WhatsApp message for one order, built on the server from that order's saved row.
  // Never logs the phone number or the message.
  app.get("/api/admin/orders/:orderId/whatsapp", requireStaff, requireDatabase, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { orderId } = req.params;
    if (!ORDER_ID_PATTERN.test(orderId)) return res.status(400).json({ error: "That isn't a valid order ID." });
    const [{ data, error }, eta] = await Promise.all([
      client.from("orders").select(WHATSAPP_COLUMNS).eq("order_id", orderId).maybeSingle(),
      getDeliveryEta().catch(() => null),
    ]);
    if (error) {
      console.error("Kitchen WhatsApp message failed:", error.code || error.name);
      return res.status(502).json({ error: "Couldn't load the WhatsApp message. Try again." });
    }
    if (!data) return res.status(404).json({ error: "That order wasn't found." });
    if (!WHATSAPP_STATUSES.includes(data.status)) return res.status(409).json({ error: "This order isn't ready yet." });
    res.json(whatsappForOrder(data, eta));
  });

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
