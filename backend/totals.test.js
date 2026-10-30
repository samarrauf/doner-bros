// Tests for order totals. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { checkPricing, calculateOrderTotals, NO_TAX_NO_FEE } = require("./totals");
const { validateOrder, toOrderRow, placeOrder, priceCartItem } = require("./orders");

const menu = require(path.join(__dirname, "..", "data", "menu.json"));
const realPricing = require(path.join(__dirname, "..", "data", "pricing.json"));
const FRIDAY = { date: "2026-10-30", weekday: "Friday" };

const lines = (...paisa) => paisa.map((lineTotalPaisa) => ({ lineTotalPaisa }));
const TAXED = { taxPercent: 16, deliveryFeePaisa: 15000 };

test("the real pricing file is valid: no tax, delivery fee not set", () => {
  assert.deepEqual(checkPricing(realPricing), { pricing: { taxPercent: 0, deliveryFeePaisa: null } });
});

test("broken pricing config is refused rather than guessed", () => {
  for (const bad of [null, {}, { taxPercent: -1, deliveryFeePaisa: null }, { taxPercent: "16", deliveryFeePaisa: null },
    { taxPercent: 101, deliveryFeePaisa: 0 }, { taxPercent: 0, deliveryFeePaisa: 150.5 }, { taxPercent: 0, deliveryFeePaisa: -1 },
    { taxPercent: 0 }]) {
    assert.ok(checkPricing(bad).error, JSON.stringify(bad));
  }
});

test("pickup: subtotal minus discount, plus tax on the discounted amount, no delivery fee", () => {
  assert.deepEqual(calculateOrderTotals({ lines: lines(145000, 35000), discountPaisa: 18000, orderType: "pickup" }, TAXED), {
    subtotalPaisa: 180000,
    discountPaisa: 18000,
    taxPaisa: 25900, // 16% of Rs 1,620 = Rs 259.20, rounded to Rs 259
    deliveryFeePaisa: 0,
    totalPaisa: 162000 + 25900,
  });
});

test("delivery adds the fee after tax; an unset fee is null and left out of the total", () => {
  const set = calculateOrderTotals({ lines: lines(100000), orderType: "delivery" }, TAXED);
  assert.equal(set.deliveryFeePaisa, 15000);
  assert.equal(set.totalPaisa, 100000 + 16000 + 15000);

  const unset = calculateOrderTotals({ lines: lines(100000), orderType: "delivery" }, NO_TAX_NO_FEE);
  assert.equal(unset.deliveryFeePaisa, null);
  assert.equal(unset.totalPaisa, 100000);
});

test("tax rounds to the nearest whole rupee, and totals are whole paisa", () => {
  assert.equal(calculateOrderTotals({ lines: lines(15000) }, { taxPercent: 16, deliveryFeePaisa: null }).taxPaisa, 2400);
  assert.equal(calculateOrderTotals({ lines: lines(10300) }, { taxPercent: 5, deliveryFeePaisa: null }).taxPaisa, 500); // Rs 5.15
  assert.equal(calculateOrderTotals({ lines: lines(11000) }, { taxPercent: 5, deliveryFeePaisa: null }).taxPaisa, 600); // Rs 5.50
  const { totalPaisa } = calculateOrderTotals({ lines: lines(33333) }, { taxPercent: 7.5, deliveryFeePaisa: null });
  assert.ok(Number.isInteger(totalPaisa));
});

test("a discount can't exceed the subtotal or go negative", () => {
  assert.equal(calculateOrderTotals({ lines: lines(10000), discountPaisa: 50000 }).totalPaisa, 0);
  assert.equal(calculateOrderTotals({ lines: lines(10000), discountPaisa: -500 }).totalPaisa, 10000);
  assert.equal(calculateOrderTotals({ lines: [] }).totalPaisa, 0);
});

test("the cart's server prices give the same total as a fresh order check", () => {
  const items = [
    { itemId: "mixed-doner-plate", quantity: 2, options: [{ name: "Base", choice: "Chips" }] },
    { itemId: "seasoned-chips", quantity: 1, options: [{ name: "Extras", choice: "Add cheese" }] },
  ];
  const cartLines = items.map((item) => priceCartItem(item, menu).line);
  const fromCart = calculateOrderTotals({ lines: cartLines, orderType: "pickup" }, TAXED);

  const args = { customerConfirmed: true, orderType: "pickup", customerName: "Ali", customerPhone: "0300 1234567", items };
  const order = validateOrder(args, menu, [], FRIDAY, TAXED).order;
  assert.equal(order.totalPaisa, fromCart.totalPaisa);
  assert.equal(order.subtotalPaisa, 2 * 145000 + 45000);
});

test("prices the model sends are ignored, and the saved row carries tax and fee", async () => {
  const args = {
    customerConfirmed: true,
    orderType: "delivery",
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Satellite Town",
    items: [{ itemId: "ayran", quantity: 2, pricePaisa: 1, lineTotalPaisa: 1 }],
    subtotalPaisa: 1,
    taxPaisa: 0,
    totalPaisa: 1,
  };
  let row;
  const result = await placeOrder({ args, menu, promotions: [], today: FRIDAY, pricing: TAXED, phone: "0301 8474036",
    saveOrder: async (r) => { row = r; return 9; } });
  assert.equal(result.status, "saved");
  assert.equal(row.subtotal_paisa, 30000);
  assert.equal(row.tax_paisa, 4800);
  assert.equal(row.delivery_fee_paisa, 15000);
  assert.equal(row.total_paisa, 30000 + 4800 + 15000);
  assert.match(result.reply, /Tax: Rs 48\nDelivery fee: Rs 150\nTotal: Rs 498 for delivery/);
});

test("an unset delivery fee is saved as null and the customer is told", async () => {
  const args = {
    customerConfirmed: true,
    orderType: "delivery",
    customerName: "Sara",
    customerPhone: "0300 1234567",
    deliveryAddress: "House 12, Street 4, Satellite Town",
    items: [{ itemId: "ayran", quantity: 1 }],
  };
  const order = validateOrder(args, menu, [], FRIDAY, NO_TAX_NO_FEE).order;
  assert.equal(toOrderRow(order).delivery_fee_paisa, null);
  const result = await placeOrder({ args, menu, promotions: [], today: FRIDAY, pricing: NO_TAX_NO_FEE, phone: "0301 8474036", saveOrder: async () => 10 });
  assert.match(result.reply, /Delivery fee: not included; the restaurant will confirm it/);
});
