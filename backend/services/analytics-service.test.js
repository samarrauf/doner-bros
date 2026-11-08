// Tests for the dashboard sales figures, with a fake Supabase client. Run with: npm test
// Orders here are made up; no menu item, deal or price from the real menu appears.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAnalyticsService, summarise, normaliseRange, percentChange } = require("./analytics-service");
const time = require("./karachi-time");

// Enough of the query builder for analytics-service: filters on created_at and status, paging.
function fakeClient(orders) {
  return {
    from: () => {
      const filters = [];
      const query = {
        select: () => query,
        gte: (column, value) => (filters.push((row) => row[column] >= value), query),
        lt: (column, value) => (filters.push((row) => row[column] < value), query),
        in: (column, values) => (filters.push((row) => values.includes(row[column])), query),
        order: () => query,
        limit: async () => ({ data: orders.filter((r) => filters.every((f) => f(r))), error: null }),
        range: async (from, to) => ({
          data: orders
            .filter((row) => filters.every((f) => f(row)))
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .slice(from, to + 1),
          error: null,
        }),
      };
      return query;
    },
  };
}

let counter = 0;
function order({ at, type = "pickup", status = "NEW", subtotal = 50000, discount = 0, phone = "03000000001", items } = {}) {
  counter += 1;
  return {
    order_id: `DB-20261108-TEST${String(counter).padStart(2, "0")}`,
    created_at: new Date(at).toISOString(),
    status,
    order_type: type,
    customer_phone: phone,
    items: items || [{ itemId: "test-item", name: "Test item", quantity: 1, unitPricePaisa: subtotal, lineTotalPaisa: subtotal }],
    subtotal_paisa: subtotal,
    discount_paisa: discount,
    tax_paisa: 0,
    delivery_fee_paisa: type === "delivery" ? 0 : null,
    total_paisa: subtotal - discount,
    promotion_id: null,
  };
}

// 2026-11-08 12:00 in Karachi is 07:00 UTC.
const NOON_KARACHI = Date.parse("2026-11-08T07:00:00Z");
const service = (orders, nowMs = NOON_KARACHI) => createAnalyticsService({ client: fakeClient(orders), now: () => new Date(nowMs) });

test("a day with no orders is all zeros, not missing fields", async () => {
  const today = await service([]).getToday();
  assert.equal(today.from, "2026-11-08");
  assert.equal(today.to, "2026-11-08");
  assert.equal(today.orderCount, 0);
  assert.equal(today.uniqueCustomers, 0);
  assert.equal(today.netSalesPaisa, 0);
  assert.equal(today.averageOrderValuePaisa, 0);
  assert.deepEqual(today.delivery, { orderCount: 0, netSalesPaisa: 0 });
  assert.deepEqual(today.pickup, { orderCount: 0, netSalesPaisa: 0 });
  assert.deepEqual(today.cancelled, { orderCount: 0, valuePaisa: 0 });
});

test("a day with one order", async () => {
  const one = order({ at: NOON_KARACHI, subtotal: 43000, discount: 3000 });
  const today = await service([one]).getToday();
  assert.equal(today.orderCount, 1);
  assert.equal(today.uniqueCustomers, 1);
  assert.equal(today.grossSalesPaisa, 43000);
  assert.equal(today.discountPaisa, 3000);
  assert.equal(today.netSalesPaisa, 40000, "the total, which already has the discount taken off");
  assert.equal(today.averageOrderValuePaisa, 40000);
  assert.ok(Number.isInteger(today.netSalesPaisa));
});

test("delivery and pickup are split, and add up to the day", () => {
  const s = summarise([
    order({ at: NOON_KARACHI, type: "delivery", subtotal: 70000, phone: "03000000001" }),
    order({ at: NOON_KARACHI, type: "delivery", subtotal: 30000, phone: "03000000002" }),
    order({ at: NOON_KARACHI, type: "pickup", subtotal: 25000, phone: "03000000001" }),
  ]);
  assert.deepEqual(s.delivery, { orderCount: 2, netSalesPaisa: 100000 });
  assert.deepEqual(s.pickup, { orderCount: 1, netSalesPaisa: 25000 });
  assert.equal(s.orderCount, s.delivery.orderCount + s.pickup.orderCount);
  assert.equal(s.netSalesPaisa, s.delivery.netSalesPaisa + s.pickup.netSalesPaisa);
  assert.equal(s.uniqueCustomers, 2, "distinct phone numbers");
  assert.equal(s.averageOrderValuePaisa, Math.floor(125000 / 3), "whole paisa, rounded down");
});

test("a cancelled order is left out of sales and counted apart", () => {
  const s = summarise([
    order({ at: NOON_KARACHI, subtotal: 60000 }),
    order({ at: NOON_KARACHI, subtotal: 90000, status: "CANCELLED", type: "delivery", phone: "03000000009" }),
  ]);
  assert.equal(s.orderCount, 1);
  assert.equal(s.netSalesPaisa, 60000);
  assert.equal(s.uniqueCustomers, 1);
  assert.deepEqual(s.delivery, { orderCount: 0, netSalesPaisa: 0 });
  assert.deepEqual(s.cancelled, { orderCount: 1, valuePaisa: 90000 });
});

test("the month turns over at Karachi midnight, not UTC midnight", async () => {
  // 2026-10-31 23:59:59 in Karachi = 18:59:59 UTC; 2026-11-01 00:00:00 in Karachi = 19:00:00 UTC.
  const lastSecondOfOctober = order({ at: "2026-10-31T18:59:59Z", subtotal: 10000 });
  const firstSecondOfNovember = order({ at: "2026-10-31T19:00:00Z", subtotal: 20000 });
  assert.equal(time.karachiDate(lastSecondOfOctober.created_at), "2026-10-31");
  assert.equal(time.karachiDate(firstSecondOfNovember.created_at), "2026-11-01");

  const month = await service([lastSecondOfOctober, firstSecondOfNovember]).getMonth();
  assert.equal(month.thisMonth.month, "2026-11");
  assert.equal(month.thisMonth.orderCount, 1);
  assert.equal(month.thisMonth.revenuePaisa, 20000);
  assert.equal(month.lastMonth.month, "2026-10");
  assert.equal(month.lastMonth.to, "2026-10-31");
  assert.equal(month.lastMonth.orderCount, 1);
  assert.equal(month.lastMonth.revenuePaisa, 10000);
  assert.equal(month.change.revenuePercent, 100);
});

test("today is the Karachi day even when UTC is still on yesterday", async () => {
  // 2026-11-08 01:00 in Karachi is 2026-11-07 20:00 UTC.
  const earlyMorning = Date.parse("2026-11-07T20:00:00Z");
  const today = await service([order({ at: earlyMorning })], earlyMorning).getToday();
  assert.equal(today.from, "2026-11-08");
  assert.equal(today.orderCount, 1);
});

test("hourly buckets use Karachi hours", async () => {
  const { hours } = await service([order({ at: "2026-11-07T19:30:00Z" }), order({ at: NOON_KARACHI })]).getHourly("2026-11-08");
  assert.equal(hours.length, 24);
  assert.equal(hours[0].orderCount, 1);
  assert.equal(hours[12].orderCount, 1);
});

test("bad ranges are refused", () => {
  assert.throws(() => normaliseRange("2026-11-31", undefined, "2026-11-08"), { code: "BAD_RANGE" });
  assert.throws(() => normaliseRange("2026-11-08", "2026-11-01", "2026-11-08"), { code: "BAD_RANGE" });
  assert.deepEqual(normaliseRange(undefined, undefined, "2026-11-08"), { from: "2026-11-08", to: "2026-11-08", days: 1 });
});

test("percentage change has no base when the previous figure is zero", () => {
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(150, 100), 50);
  assert.equal(percentChange(1, 3), -66.7);
});
