// Doner Bros — staff dashboard: the /staff page and the API it uses to list orders from Supabase
// and move them through NEW -> PREPARING -> READY -> COMPLETED. Everything here is behind the
// staff password (STAFF_PASSWORD in .env), checked on the server.

const crypto = require("crypto");
const path = require("path");
const { rateLimitKey, createMemoryRateLimiter } = require("./rate-limit");

const STATUS_FLOW = ["NEW", "PREPARING", "READY", "COMPLETED"];
const ORDER_ID_PATTERN = /^DB-\d{8}-[A-HJ-NP-Z2-9]{6}$/;
const MAX_ORDERS = 100;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const ORDER_FIELDS =
  "order_id, created_at, status, order_type, customer_name, customer_phone, delivery_address, delivery_unit, " +
  "delivery_instructions, pickup_time, items, subtotal_paisa, discount_paisa, tax_paisa, delivery_fee_paisa, total_paisa";

// The only move allowed from a status: one step forward. null at the end of the flow.
function nextStatus(status) {
  const index = STATUS_FLOW.indexOf(status);
  return index >= 0 && index < STATUS_FLOW.length - 1 ? STATUS_FLOW[index + 1] : null;
}

// HTTP Basic auth: any username, the staff password. Compared in constant time.
function isStaffPassword(authorizationHeader, password) {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(authorizationHeader || ""));
  if (!match || !password) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

// rateLimiter: from rate-limit.js, so failures are counted across every copy of the server.
function createLoginLimiter(rateLimiter, { windowMs = LOGIN_WINDOW_MS, maxFailures = MAX_FAILED_LOGINS } = {}) {
  const key = (ip) => rateLimitKey("staff-login", ip);
  return {
    isBlocked: async (ip, now) => (await rateLimiter.hit(key(ip), windowMs, false, now)) >= maxFailures,
    recordFailure: (ip, now) => rateLimiter.hit(key(ip), windowMs, true, now),
  };
}

// app: the Express app. client: Supabase client using the service role key, or null if not set up.
// rateLimiter: from rate-limit.js; in memory if not given.
function addStaffRoutes(app, { client, password, adminDir, rateLimiter = createMemoryRateLimiter() }) {
  const limiter = createLoginLimiter(rateLimiter);

  async function requireStaff(req, res, next) {
    res.setHeader("Cache-Control", "no-store"); // customer details must not be cached
    if (!password) return res.status(503).json({ error: "Staff dashboard isn't set up: add STAFF_PASSWORD to .env." });
    let allowed;
    try {
      if (await limiter.isBlocked(req.ip)) return res.status(429).json({ error: "Too many wrong passwords. Try again in 15 minutes." });
      allowed = isStaffPassword(req.headers.authorization, password);
      if (!allowed && req.headers.authorization) await limiter.recordFailure(req.ip);
    } catch (error) {
      console.error("Staff login limit check failed:", error.code || error.message);
      return res.status(503).json({ error: "Couldn't check the password right now. Try again in a minute." });
    }
    if (allowed) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="Doner Bros staff", charset="UTF-8"');
    return res.status(401).json({ error: "Staff password required." });
  }

  function requireDatabase(req, res, next) {
    if (!client) return res.status(503).json({ error: "Orders database isn't configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return next();
  }

  app.get("/staff", requireStaff, (req, res) => res.sendFile(path.join(adminDir, "index.html")));

  // Active orders (not completed), oldest first so the kitchen works top down; or recent completed ones.
  app.get("/api/staff/orders", requireStaff, requireDatabase, async (req, res) => {
    const completed = req.query.completed === "1";
    let query = client.from("orders").select(ORDER_FIELDS);
    query = completed
      ? query.eq("status", "COMPLETED").order("created_at", { ascending: false })
      : query.neq("status", "COMPLETED").order("created_at", { ascending: true });
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
}

module.exports = { STATUS_FLOW, nextStatus, isStaffPassword, createLoginLimiter, addStaffRoutes };
