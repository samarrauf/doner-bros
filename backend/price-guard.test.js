// Tests for the price guard. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { rupeeAmounts, findUnbackedPrices } = require("./price-guard");

test("reads every way of writing a rupee amount, as whole paisa", () => {
  assert.deepEqual(rupeeAmounts("Rs 12"), [1200]);
  assert.deepEqual(rupeeAmounts("rs. 1,234"), [123400]);
  assert.deepEqual(rupeeAmounts("Rs12.50"), [1250]);
  assert.deepEqual(rupeeAmounts("PKR 12"), [1200]);
  assert.deepEqual(rupeeAmounts("12 rupees"), [1200]);
  assert.deepEqual(rupeeAmounts("12 rupay"), [1200]);
  assert.deepEqual(rupeeAmounts("12/-"), [1200]);
});

test("ignores numbers that are not rupee amounts", () => {
  assert.deepEqual(rupeeAmounts("Deal 2 has 5 pieces, 500ml. WhatsApp 03001234567."), []);
  assert.deepEqual(rupeeAmounts("Deal 2 Rs 34"), [3400], "the 2 isn't read as an amount");
});

test("an amount from a tool result this turn passes, as paisa or as text", () => {
  assert.deepEqual(findUnbackedPrices("It is Rs 12.", [{ item: { pricePaisa: 1200 } }]), []);
  assert.deepEqual(findUnbackedPrices("It is Rs 1,234.", [{ cartTotal: "Rs 1,234" }]), []);
  assert.deepEqual(findUnbackedPrices("It is 12 rupees.", [{ deals: [{ pricePaisa: 1200 }] }]), []);
});

test("an amount no tool returned is reported", () => {
  assert.deepEqual(findUnbackedPrices("It is Rs 12.", []), [1200]);
  assert.deepEqual(findUnbackedPrices("Rs 12 or Rs 13, not Rs 12 again", [{ pricePaisa: 1300 }]), [1200]);
});

test("a paisa number only counts under a paisa key", () => {
  assert.deepEqual(findUnbackedPrices("It is Rs 12.", [{ itemCount: 1200 }]), [1200]);
});

test("a reply with no amounts always passes", () => {
  assert.deepEqual(findUnbackedPrices("Which one would you like?", []), []);
});
