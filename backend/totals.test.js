// Tests for order totals. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { priceCart, calculateTotals, describeCart, MAX_QUANTITY } = require("./totals");
const { useFakeMenu } = require("./fake-menu");
const menuService = require("./services/menu-service");

const TAXED = { tax_mode: "exclusive", tax_rate_bps: "1600", delivery_fee_paisa: "15000" };
const line = (item_id, quantity = 1) => ({ item_id, quantity, option_ids: [] });
const total = (cart, options = {}) => calculateTotals({ cart, ...options });

test.beforeEach(() => useFakeMenu());

test("one item: paisa integers and display strings", async () => {
  const result = await total([line("i-main")]);
  assert.equal(result.subtotalPaisa, 75000);
  assert.equal(result.discountPaisa, 0);
  assert.equal(result.taxPaisa, 0);
  assert.equal(result.deliveryFeePaisa, 0);
  assert.equal(result.totalPaisa, 75000);
  assert.deepEqual(result.display, { subtotal: "Rs 750", discount: "Rs 0", tax: "Rs 0", taxIncluded: "Rs 0", deliveryFee: "Rs 0", total: "Rs 750" });
  assert.equal(result.lines[0].name, "Test Main");
  assert.equal(result.lines[0].unitPriceDisplay, "Rs 750");
});

test("several items, with quantities", async () => {
  const result = await total([line("i-main", 2), line("i-side"), line("i-drink", 3)]);
  assert.deepEqual(result.lines.map((l) => l.lineTotalPaisa), [150000, 35000, 45000]);
  assert.equal(result.subtotalPaisa, 230000);
  assert.equal(result.totalPaisa, 230000);
  assert.equal(result.display.total, "Rs 2,300");
});

test("the same item on two lines is priced on both", async () => {
  assert.equal((await total([line("i-drink"), line("i-drink", 2)])).subtotalPaisa, 45000);
});

test("an unknown id is rejected, naming that id", async () => {
  const result = await total([line("i-main"), line("no-such-id")]);
  assert.equal(result.totalPaisa, undefined);
  assert.equal(result.code, "items_not_orderable");
  assert.deepEqual(result.missingIds, ["no-such-id"]);
  assert.deepEqual(result.unavailableItems, []);
  assert.match(result.error, /not on the menu: no-such-id/);
});

test("a finished item is rejected by name, told apart from one that doesn't exist", async () => {
  const result = await total([line("i-main"), line("i-finished")]);
  assert.equal(result.totalPaisa, undefined);
  assert.deepEqual(result.missingIds, []);
  assert.deepEqual(result.unavailableItems, [{ id: "i-finished", name: "Test Finished" }]);
  assert.match(result.error, /finished for now: Test Finished/);
  assert.doesNotMatch(result.error, /not on the menu/);
});

test("both checks run: unknown and finished are reported together", async () => {
  const result = await total([line("no-such-id"), line("i-finished")]);
  assert.deepEqual(result.missingIds, ["no-such-id"]);
  assert.deepEqual(result.unavailableItems, [{ id: "i-finished", name: "Test Finished" }]);
});

test("deals are priced from the service, and an unavailable one counts as finished", async () => {
  const combo = await total([line("d-combo", 2), line("i-drink")]);
  assert.equal(combo.subtotalPaisa, 2 * 90000 + 15000);
  assert.equal(combo.lines[0].name, "Test Combo");
  assert.deepEqual((await total([line("d-gone")])).unavailableItems, [{ id: "d-gone", name: "Test Gone" }]);
});

test("a cart mixing deals and single items: each deal is one line at the deal price", async () => {
  useFakeMenu({ settings: TAXED });
  const result = await total([line("d-combo", 2), line("i-main"), line("d-combo"), line("i-drink", 3)], { orderType: "delivery" });

  assert.deepEqual(
    result.lines.map((l) => [l.name, l.quantity, l.unitPricePaisa, l.lineTotalPaisa]),
    [
      ["Test Combo", 2, 90000, 180000],
      ["Test Main", 1, 75000, 75000],
      ["Test Combo", 1, 90000, 90000],
      ["Test Drink", 3, 15000, 45000],
    ]
  );
  // Priced by its parts, one deal would be 75000 + 35000 = 110000.
  assert.equal(result.subtotalPaisa, 390000);
  assert.equal(result.taxPaisa, 62400); // 16% of Rs 3,900 = Rs 624
  assert.equal(result.deliveryFeePaisa, 15000);
  assert.equal(result.totalPaisa, 390000 + 62400 + 15000);
  assert.equal(result.display.total, "Rs 4,674");

  assert.deepEqual(result.lines[0].contains, ["1 Test Main", "1 Test Side", "1 Test Extra"]);
  assert.equal("contains" in result.lines[1], false, "a plain item has no contents");
});

test("a mixed cart with one unavailable deal is refused as a whole", async () => {
  const result = await total([line("i-main"), line("d-combo"), line("d-gone")]);
  assert.equal(result.code, "items_not_orderable");
  assert.deepEqual(result.unavailableItems, [{ id: "d-gone", name: "Test Gone" }]);
});

test("a quantity of zero is rejected, naming the item", async () => {
  const result = await total([line("i-main", 0)]);
  assert.equal(result.code, "invalid_quantity");
  assert.match(result.error, /Test Main: quantity must be a whole number from 1 to 20/);
});

test("negative, fractional and non-number quantities are rejected", async () => {
  for (const quantity of [-1, 1.5, "2", null, NaN]) {
    assert.equal((await total([line("i-main", quantity)])).code, "invalid_quantity", String(quantity));
  }
  assert.equal((await total([{ item_id: "i-main" }])).code, "invalid_quantity", "no quantity at all");
});

test("a very large quantity is rejected, and the limit itself is allowed", async () => {
  for (const quantity of [MAX_QUANTITY + 1, 1000000, Number.MAX_SAFE_INTEGER, 1e308, Infinity]) {
    assert.equal((await total([line("i-main", quantity)])).code, "invalid_quantity", String(quantity));
  }
  assert.equal((await total([line("i-main", MAX_QUANTITY)])).totalPaisa, 75000 * MAX_QUANTITY);
});

test("a total too big for the orders table is refused rather than overflowing", async () => {
  useFakeMenu({ prices: { "i-main": 2000000000 } });
  assert.equal((await total([line("i-main", 2)])).code, "order_too_large");
});

test("empty, oversized and malformed carts are rejected", async () => {
  for (const cart of [[], null, "i-main", [null], [{ quantity: 1 }], [{ item_id: "", quantity: 1 }], Array(21).fill(line("i-drink"))]) {
    assert.equal((await total(cart)).code, "invalid_cart");
  }
});

test("a price on a cart line is ignored: only the ids and quantity are read", async () => {
  const cart = [{ item_id: "i-main", quantity: 1, pricePaisa: 1, unitPricePaisa: 1, lineTotalPaisa: 1, totalPaisa: 1 }];
  assert.equal((await total(cart)).totalPaisa, 75000);
});

test("prices are the menu's at the moment of calculating", async () => {
  assert.equal((await total([line("i-main")])).totalPaisa, 75000);
  useFakeMenu({ prices: { "i-main": 80000 } });
  assert.equal((await total([line("i-main")])).totalPaisa, 80000);
});

test("an option id can't be priced while the menu has no options", async () => {
  const result = await total([{ item_id: "i-main", quantity: 1, option_ids: ["opt-1"] }]);
  assert.equal(result.code, "unknown_option");
  assert.equal((await total([{ item_id: "i-main", quantity: 1 }])).totalPaisa, 75000, "no option_ids at all is fine");
});

test("exclusive tax is added on the discounted amount, then the delivery fee after tax", async () => {
  useFakeMenu({ settings: TAXED });
  const result = await total([line("loaded-bro-box"), line("i-side")], { orderType: "pickup", getDiscount: () => 18000 });
  assert.equal(result.subtotalPaisa, 160000);
  assert.equal(result.discountPaisa, 18000);
  assert.equal(result.taxPaisa, 22700); // 16% of Rs 1,420 = Rs 227.20, rounded to Rs 227
  assert.equal(result.deliveryFeePaisa, 0, "pickup pays no delivery fee");
  assert.equal(result.totalPaisa, 142000 + 22700);

  const delivery = await total([line("i-main")], { orderType: "delivery" });
  assert.equal(delivery.deliveryFeePaisa, 15000);
  assert.equal(delivery.totalPaisa, 75000 + 12000 + 15000);
  assert.equal(delivery.display.deliveryFee, "Rs 150");
});

test("tax rounds to the nearest whole rupee in whole-number arithmetic", async () => {
  const rounds = async (price, bps) => {
    useFakeMenu({ settings: { tax_mode: "exclusive", tax_rate_bps: String(bps), delivery_fee_paisa: "0" }, prices: { "i-main": price } });
    return (await total([line("i-main")])).taxPaisa;
  };
  assert.equal(await rounds(15000, 1600), 2400);
  assert.equal(await rounds(10300, 500), 500); // Rs 5.15
  assert.equal(await rounds(11000, 500), 600); // Rs 5.50
  assert.ok(Number.isInteger(await rounds(33333, 750)));
});

test("inclusive tax is reported but not added to the total", async () => {
  useFakeMenu({ settings: { tax_mode: "inclusive", tax_rate_bps: "2500", delivery_fee_paisa: "0" } });
  const result = await total([line("i-main")]);
  assert.equal(result.taxPaisa, 0, "the orders table requires total = subtotal - discount + tax + fee");
  assert.equal(result.taxIncludedPaisa, 15000); // Rs 750 at 25% inclusive holds Rs 150 of tax
  assert.equal(result.totalPaisa, 75000);
});

test("tax mode none ignores any rate", async () => {
  useFakeMenu({ settings: { tax_mode: "none", tax_rate_bps: "1600", delivery_fee_paisa: "0" } });
  assert.equal((await total([line("i-main")])).taxPaisa, 0);
});

test("a discount can't exceed the subtotal or go negative, and must be whole paisa", async () => {
  assert.equal((await total([line("i-main")], { getDiscount: () => 999999 })).totalPaisa, 0);
  assert.equal((await total([line("i-main")], { getDiscount: () => -500 })).totalPaisa, 75000);
  await assert.rejects(total([line("i-main")], { getDiscount: () => 0.5 }), TypeError);
});

test("missing or broken settings refuse to price rather than guess", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const settings of [
      {},
      { tax_mode: "none", tax_rate_bps: "0" },
      { tax_mode: "gst", tax_rate_bps: "0", delivery_fee_paisa: "0" },
      { tax_mode: "none", tax_rate_bps: "16.5", delivery_fee_paisa: "0" },
      { tax_mode: "none", tax_rate_bps: "10001", delivery_fee_paisa: "0" },
      { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: "-1" },
      { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: "free" },
    ]) {
      useFakeMenu({ settings });
      assert.equal((await total([line("i-main")])).code, "bad_settings", JSON.stringify(settings));
    }
  } finally {
    console.error = originalError;
  }
});

test("a menu outage is thrown, never turned into a price", async () => {
  menuService.setClient(null);
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(total([line("i-main")]), { code: "MENU_UNAVAILABLE" });
  } finally {
    console.error = originalError;
  }
});

test("priceCart needs no settings, and describeCart never refuses", async () => {
  assert.equal((await priceCart([line("i-side", 2)])).subtotalPaisa, 70000);
  assert.deepEqual(await describeCart([line("i-main"), line("i-finished"), line("no-such-id", 2)]), [
    { itemId: "i-main", quantity: 1, name: "Test Main", orderable: true },
    { itemId: "i-finished", quantity: 1, name: "Test Finished", orderable: false },
    { itemId: "no-such-id", quantity: 2, name: "an item no longer on the menu", orderable: false },
  ]);
});
