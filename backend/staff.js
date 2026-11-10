// Doner Bros — the order-list API: lists orders from Supabase and moves them through
// NEW -> PREPARING -> READY -> COMPLETED. Behind a kitchen or owner session (auth.js), checked on
// the server. The old /staff page now redirects to /kitchen/login (auth.js).

const STATUS_FLOW = ["NEW", "PREPARING", "READY", "COMPLETED"];
const ORDER_ID_PATTERN = /^DB-\d{8}-[A-HJ-NP-Z2-9]{6}$/;
const MAX_ORDERS = 100;
const ORDER_FIELDS =
  "order_id, created_at, status, order_type, customer_name, customer_phone, delivery_address, delivery_unit, " +
  "delivery_instructions, pickup_time, items, subtotal_paisa, discount_paisa, tax_paisa, delivery_fee_paisa, total_paisa, chat_session_id";

// The only move allowed from a status: one step forward. null at the end of the flow.
function nextStatus(status) {
  const index = STATUS_FLOW.indexOf(status);
  return index >= 0 && index < STATUS_FLOW.length - 1 ? STATUS_FLOW[index + 1] : null;
}

// app: the Express app. client: Supabase client using the service role key, or null if not set up.
// requireKitchen: from auth.js (a staff or owner session).
function addStaffRoutes(app, { client, requireKitchen }) {
  const requireStaff = requireKitchen;

  function requireDatabase(req, res, next) {
    if (!client) return res.status(503).json({ error: "Orders database isn't configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return next();
  }

  // Active orders (not completed), oldest first so the kitchen works top down; or recent completed ones.
  app.get("/api/staff/orders", requireStaff, requireDatabase, async (req, res) => {
    const completed = req.query.completed === "1";
    let query = client.from("orders").select(ORDER_FIELDS);
    query = completed
      ? query.eq("status", "COMPLETED").order("created_at", { ascending: false })
      : query.in("status", ["NEW", "PREPARING", "READY"]).order("created_at", { ascending: true });
    const { data, error } = await query.limit(MAX_ORDERS);
    if (error) {
      console.error("Staff order list failed:", error.code || error.name);
      return res.status(502).json({ error: "Couldn't load orders. Try again." });
    }
    res.json({ orders: data });
  });

  // Moves an order one step on, only if it's still in the status the staff member saw. So two
  // people clicking at once can't skip a step: the second gets 409 and the list refreshes.
  app.post("/api/staff/orders/:orderId/advance", requireStaff, requireDatabase, async (req, res) => {
    const { orderId } = req.params;
    const from = req.body && req.body.from;
    if (!ORDER_ID_PATTERN.test(orderId)) return res.status(400).json({ error: "That isn't a valid order ID." });
    const to = nextStatus(from);
    if (!to) return res.status(400).json({ error: "That order can't be moved on from its current status." });

    const { data, error } = await client
      .from("orders")
      .update({ status: to })
      .eq("order_id", orderId)
      .eq("status", from)
      .select("order_id, status")
      .maybeSingle();
    if (error) {
      console.error("Staff status update failed:", error.code || error.name);
      return res.status(502).json({ error: "Couldn't update the order. Try again." });
    }
    if (!data) return res.status(409).json({ error: "This order was already changed. The list has been refreshed." });
    console.log(`Order ${orderId}: ${from} -> ${to}.`);
    res.json({ order: data });
  });

  return { requireDatabase };
}

module.exports = { STATUS_FLOW, nextStatus, addStaffRoutes };
