const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { suggestItems } = require("./recommendations");
const { createOrderState, addToCart } = require("./order-session");

const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "menu.json"), "utf8"));
const menuIds = new Set(MENU.categories.flatMap((c) => c.items.map((item) => item.id)));

function cartWith(...itemIds) {
  const state = createOrderState();
  state.items = itemIds.map((itemId) => ({ itemId, quantity: 1, options: [] }));
  return state;
}

const ids = (suggestions) => suggestions.map((s) => s.itemId);

test("an empty cart gets no suggestions", () => {
  assert.deepStrictEqual(suggestItems(createOrderState(), MENU), []);
});

test("a main gets a drink and a side from the real menu, at its menu price", () => {
  const suggestions = suggestItems(cartWith("mixed-doner-plate"), MENU);
  assert.deepStrictEqual(ids(suggestions), ["ayran", "seasoned-chips"]);
  assert.strictEqual(suggestions[0].pricePaisa, 15000);
  assert.ok(suggestions.every((s) => menuIds.has(s.itemId)));
});

test("each kind of suggestion is offered only once per chat", () => {
  const state = cartWith("mixed-doner-plate");
  assert.strictEqual(suggestItems(state, MENU).length, 2);
  assert.deepStrictEqual(suggestItems(state, MENU), []);
  state.items.push({ itemId: "doner-box", quantity: 1, options: [] });
  assert.deepStrictEqual(suggestItems(state, MENU), [], "a declined drink isn't swapped for a different drink");
});

test("kinds already in the cart aren't suggested", () => {
  assert.deepStrictEqual(ids(suggestItems(cartWith("doner-box", "ayran"), MENU)), ["seasoned-chips"]);
  assert.deepStrictEqual(suggestItems(cartWith("doner-box", "ayran", "halloumi-fries"), MENU), []);
});

test("a cart with no main gets one main, a bestseller", () => {
  assert.deepStrictEqual(ids(suggestItems(cartWith("seasoned-chips", "ayran"), MENU)), ["classic-doner-kebab"]);
});

test("an all-vegetarian cart gets a vegetarian side", () => {
  assert.deepStrictEqual(ids(suggestItems(cartWith("falafel-wrap"), MENU)), ["ayran", "halloumi-fries"]);
});

test("unavailable, malformed and unknown items are never suggested", () => {
  const menu = JSON.parse(JSON.stringify(MENU));
  const drinks = menu.categories.find((c) => c.name === "Drinks").items;
  drinks[0].availability = "unavailable";
  const sides = menu.categories.find((c) => c.name === "Sides").items;
  sides.forEach((item) => { item.pricePaisa = "350"; });
  assert.deepStrictEqual(ids(suggestItems(cartWith("doner-box"), menu)), ["soft-drinks"]);
  assert.deepStrictEqual(ids(suggestItems(cartWith("made-up-item"), menu)), ["classic-doner-kebab"], "unknown lines count as no main");
  assert.deepStrictEqual(suggestItems(cartWith("doner-box"), { categories: "broken" }), []);
});

test("a new cart after a saved order keeps what was already offered", () => {
  const state = cartWith("mixed-doner-plate");
  suggestItems(state, MENU);
  state.status = "saved";
  addToCart(state, { itemId: "doner-box", quantity: 1, options: [], lineTotalPaisa: 85000 });
  assert.strictEqual(state.items.length, 1);
  assert.deepStrictEqual(suggestItems(state, MENU), []);
});
