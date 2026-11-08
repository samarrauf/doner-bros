// Doner Bros — sales figures for the owner dashboard, read from the Supabase "orders" table.
// Sales only: there is no cost or profit anywhere. Every amount is integer paisa, added up here in
// backend code (never by the AI model). Days, hours and months are Asia/Karachi.
//
// Net sales = sum of order totals. An order's total_paisa already has its discount taken off
// (total = subtotal - discount + tax + delivery fee, enforced by the table), so discounts are not
// subtracted a second time. Cancelled orders are left out of every sales figure and counted apart.

const time = require("./karachi-time");

const PAGE_SIZE = 1000;
const OPEN_STATUSES = ["NEW", "PREPARING", "READY"];
const CANCELLED = "CANCELLED";
const MAX_RANGE_DAYS = 366;
const SUMMARY_COLUMNS =
  "order_id, created_at, status, order_type, customer_phone, items, subtotal_paisa, discount_paisa, tax_paisa, delivery_fee_paisa, total_paisa, promotion_id";

const sum = (rows, pick) => rows.reduce((total, row) => total + (Number.isInteger(pick(row)) ? pick(row) : 0), 0);

// Percentage change from previous to current, to one decimal place. null when there's no base.
function percentChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) * 1000) / previous) / 10;
}

function badRange(message) {
  return Object.assign(new Error(message), { code: "BAD_RANGE" });
}

// Checks a from/to pair of "YYYY-MM-DD" Karachi dates (inclusive). Either may be left out: from
// defaults to today, to defaults to from.
function normaliseRange(from, to, today) {
  const start = from || today;
  const end = to || (from ? from : today);
  if (!time.parseDate(start)) throw badRange("from must be a date like 2026-11-08.");
  if (!time.parseDate(end)) throw badRange("to must be a date like 2026-11-08.");
  const days = time.daysBetween(start, end) + 1;
  if (days < 1) throw badRange("to must be on or after from.");
  if (days > MAX_RANGE_DAYS) throw badRange(`A range can be at most ${MAX_RANGE_DAYS} days.`);
  return { from: start, to: end, days };
}

/* ---------- Pure figures from order rows (tested without a database) ---------- */

function salesOf(orders) {
  return { orderCount: orders.length, netSalesPaisa: sum(orders, (o) => o.total_paisa) };
}

// Share of part in whole as a percentage to one decimal place. null when whole is zero.
function sharePercent(part, whole) {
  return whole ? Math.round((part * 1000) / whole) / 10 : null;
}

function summarise(orders) {
  const sold = orders.filter((o) => o.status !== CANCELLED);
  const cancelled = orders.filter((o) => o.status === CANCELLED);
  const netSalesPaisa = sum(sold, (o) => o.total_paisa);
  const deliveryCount = sold.filter((o) => o.order_type === "delivery").length;
  return {
    deliverySharePercent: sharePercent(deliveryCount, sold.length),
    orderCount: sold.length,
    uniqueCustomers: new Set(sold.map((o) => o.customer_phone)).size,
    netSalesPaisa,
    grossSalesPaisa: sum(sold, (o) => o.subtotal_paisa),
    discountPaisa: sum(sold, (o) => o.discount_paisa),
    taxPaisa: sum(sold, (o) => o.tax_paisa),
    deliveryFeePaisa: sum(sold, (o) => o.delivery_fee_paisa),
    // Whole paisa, rounded down.
    averageOrderValuePaisa: sold.length ? Math.floor(netSalesPaisa / sold.length) : 0,
    delivery: salesOf(sold.filter((o) => o.order_type === "delivery")),
    pickup: salesOf(sold.filter((o) => o.order_type === "pickup")),
    cancelled: { orderCount: cancelled.length, valuePaisa: sum(cancelled, (o) => o.total_paisa) },
  };
}

function hourly(orders) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: 0, netSalesPaisa: 0 }));
  for (const order of orders) {
    if (order.status === CANCELLED) continue;
    const bucket = hours[time.karachiHour(order.created_at)];
    bucket.orderCount += 1;
    if (Number.isInteger(order.total_paisa)) bucket.netSalesPaisa += order.total_paisa;
  }
  return hours;
}

const isDealLine = (line) => Array.isArray(line.contains);

function soldLines(orders, keep) {
  const lines = [];
  for (const order of orders) {
    if (order.status === CANCELLED || !Array.isArray(order.items)) continue;
    for (const line of order.items) if (line && keep(line)) lines.push({ order, line });
  }
  return lines;
}

// Groups order lines by item id. Line sales are before any order-level discount.
function groupLines(entries) {
  const groups = new Map();
  for (const { order, line } of entries) {
    const key = line.itemId || line.name;
    const group = groups.get(key) || { itemId: line.itemId || null, name: line.name, isDeal: isDealLine(line), quantity: 0, salesPaisa: 0, orders: new Set() };
    if (Number.isInteger(line.quantity)) group.quantity += line.quantity;
    if (Number.isInteger(line.lineTotalPaisa)) group.salesPaisa += line.lineTotalPaisa;
    group.orders.add(order.order_id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ orders, ...group }) => ({ ...group, orderCount: orders.size }))
    .sort((a, b) => b.quantity - a.quantity || b.salesPaisa - a.salesPaisa);
}

function topItems(orders, limit) {
  return groupLines(soldLines(orders, () => true)).slice(0, limit);
}

function dealPerformance(orders) {
  const sold = orders.filter((o) => o.status !== CANCELLED);
  const promotions = new Map();
  for (const order of sold) {
    if (!order.promotion_id) continue;
    const p = promotions.get(order.promotion_id) || { promotionId: order.promotion_id, orderCount: 0, discountPaisa: 0, netSalesPaisa: 0 };
    p.orderCount += 1;
    p.discountPaisa += Number.isInteger(order.discount_paisa) ? order.discount_paisa : 0;
    p.netSalesPaisa += Number.isInteger(order.total_paisa) ? order.total_paisa : 0;
    promotions.set(order.promotion_id, p);
  }
  const deals = groupLines(soldLines(sold, isDealLine)).map(({ itemId, isDeal: _deal, ...deal }) => ({ dealId: itemId, ...deal }));
  return {
    deals,
    dealSalesPaisa: sum(deals, (d) => d.salesPaisa),
    ordersWithADeal: new Set(soldLines(sold, isDealLine).map(({ order }) => order.order_id)).size,
    promotions: [...promotions.values()].sort((a, b) => b.orderCount - a.orderCount),
  };
}

function repeatCustomers(orders) {
  const customers = new Map();
  for (const order of orders) {
    if (order.status === CANCELLED) continue;
    const c = customers.get(order.customer_phone) || { phone: order.customer_phone, orderCount: 0, totalSpendPaisa: 0, lastOrderAt: null };
    c.orderCount += 1;
    if (Number.isInteger(order.total_paisa)) c.totalSpendPaisa += order.total_paisa;
    if (!c.lastOrderAt || order.created_at > c.lastOrderAt) c.lastOrderAt = order.created_at;
    customers.set(order.customer_phone, c);
  }
  return [...customers.values()]
    .filter((c) => c.orderCount >= 2)
    .sort((a, b) => b.orderCount - a.orderCount || b.totalSpendPaisa - a.totalSpendPaisa);
}

function change(current, previous) {
  const fields = ["orderCount", "uniqueCustomers", "netSalesPaisa", "averageOrderValuePaisa"];
  const figures = Object.fromEntries(
    fields.map((field) => [field, { difference: current[field] - previous[field], percent: percentChange(current[field], previous[field]) }])
  );
  // Delivery share is already a percentage, so its change is in percentage points.
  const a = current.deliverySharePercent;
  const b = previous.deliverySharePercent;
  figures.deliverySharePercent = { points: a === null || b === null ? null : Math.round((a - b) * 10) / 10 };
  return figures;
}

/* ---------- CSV ---------- */

const CSV_COLUMNS = [
  ["order_id", (o) => o.order_id],
  ["created_at_karachi", (o) => `${time.karachiDate(o.created_at)} ${String(time.karachiHour(o.created_at)).padStart(2, "0")}:${String(time.karachiParts(o.created_at).minute).padStart(2, "0")}`],
  ["status", (o) => o.status],
  ["order_type", (o) => o.order_type],
  ["item_count", (o) => (Array.isArray(o.items) ? sum(o.items, (l) => l.quantity) : 0)],
  ["subtotal_paisa", (o) => o.subtotal_paisa],
  ["discount_paisa", (o) => o.discount_paisa],
  ["tax_paisa", (o) => o.tax_paisa],
  ["delivery_fee_paisa", (o) => o.delivery_fee_paisa],
  ["total_paisa", (o) => o.total_paisa],
  ["promotion_id", (o) => o.promotion_id],
];

// Quotes every field, and stops a spreadsheet treating a value as a formula.
function csvField(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function ordersCsv(orders) {
  const header = CSV_COLUMNS.map(([name]) => csvField(name)).join(",");
  const rows = orders.map((o) => CSV_COLUMNS.map(([, pick]) => csvField(pick(o))).join(","));
  return [header, ...rows].join("\r\n") + "\r\n";
}

/* ---------- Service ---------- */

// client: Supabase client using the service role key. now: () => Date, for tests.
function createAnalyticsService({ client, now = () => new Date() }) {
  const today = () => time.karachiDate(now());

  // Every order with created_at in the Karachi days from..to, oldest first, a page at a time.
  async function fetchOrders(from, to, columns = SUMMARY_COLUMNS) {
    const { startIso, endIso } = time.dayRangeToUtc(from, to);
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await client
        .from("orders")
        .select(columns)
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE_SIZE) return rows;
    }
  }

  async function getRange(from, to) {
    const range = normaliseRange(from, to, today());
    const orders = await fetchOrders(range.from, range.to);
    return { from: range.from, to: range.to, timeZone: time.TIME_ZONE, ...summarise(orders) };
  }

  const getToday = () => getRange(today(), today());

  async function getComparison(from, to) {
    const range = normaliseRange(from, to, today());
    const previousTo = time.addDays(range.from, -1);
    const previousFrom = time.addDays(previousTo, -(range.days - 1));
    const [current, previous] = await Promise.all([getRange(range.from, range.to), getRange(previousFrom, previousTo)]);
    return { current, previous, change: change(current, previous) };
  }

  // This Karachi calendar month so far, against the whole of last month.
  async function getMonth() {
    const thisMonth = time.monthBounds(today());
    const lastMonth = time.monthBounds(time.addDays(thisMonth.first, -1));
    const [current, previous] = await Promise.all([
      fetchOrders(thisMonth.first, today()),
      fetchOrders(lastMonth.first, lastMonth.last),
    ]);
    const figures = (bounds, to, orders) => {
      const s = summarise(orders);
      return { month: bounds.month, from: bounds.first, to, orderCount: s.orderCount, revenuePaisa: s.netSalesPaisa, cancelledCount: s.cancelled.orderCount };
    };
    const thisFigures = figures(thisMonth, today(), current);
    const lastFigures = figures(lastMonth, lastMonth.last, previous);
    return {
      timeZone: time.TIME_ZONE,
      thisMonth: thisFigures,
      lastMonth: lastFigures,
      change: {
        orderCountPercent: percentChange(thisFigures.orderCount, lastFigures.orderCount),
        revenuePercent: percentChange(thisFigures.revenuePaisa, lastFigures.revenuePaisa),
      },
    };
  }

  // One day (date), or every day from..to added together hour by hour.
  async function getHourly(from, to) {
    const range = normaliseRange(from, to || from, today());
    return { date: range.from, from: range.from, to: range.to, timeZone: time.TIME_ZONE, hours: hourly(await fetchOrders(range.from, range.to)) };
  }

  async function getTopItems(from, to, limit = 10) {
    const range = normaliseRange(from, to, today());
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 50);
    const orders = await fetchOrders(range.from, range.to);
    return { from: range.from, to: range.to, items: topItems(orders, n) };
  }

  async function getDealPerformance(from, to) {
    const range = normaliseRange(from, to, today());
    return { from: range.from, to: range.to, ...dealPerformance(await fetchOrders(range.from, range.to)) };
  }

  async function getRepeatCustomers(from, to) {
    const range = normaliseRange(from, to, today());
    return { from: range.from, to: range.to, customers: repeatCustomers(await fetchOrders(range.from, range.to)) };
  }

  async function getLiveOrders() {
    const { data, error } = await client
      .from("orders")
      .select("order_id, created_at, status, order_type, customer_name, pickup_time, total_paisa")
      .in("status", OPEN_STATUSES)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    const at = now().getTime();
    return {
      orders: data.map((o) => ({
        orderId: o.order_id,
        status: o.status,
        orderType: o.order_type,
        customerName: o.customer_name,
        pickupTime: o.pickup_time,
        totalPaisa: o.total_paisa,
        createdAt: o.created_at,
        ageMinutes: Math.max(0, Math.floor((at - Date.parse(o.created_at)) / 60000)),
      })),
    };
  }

  async function exportCsv(from, to) {
    const range = normaliseRange(from, to, today());
    return { from: range.from, to: range.to, csv: ordersCsv(await fetchOrders(range.from, range.to)) };
  }

  return {
    getToday,
    getMonth,
    getRange,
    getComparison,
    getHourly,
    getTopItems,
    getDealPerformance,
    getRepeatCustomers,
    getLiveOrders,
    exportCsv,
  };
}

module.exports = {
  createAnalyticsService,
  normaliseRange,
  summarise,
  hourly,
  topItems,
  dealPerformance,
  repeatCustomers,
  percentChange,
  ordersCsv,
};
