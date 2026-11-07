// Tests for add-on suggestions. Run with: npm test
// The menu goes through the real menu service and getOrderableMenu, the same path as the chat, so a
// mismatch between what suggestions expect and what the service gives can't hide here again.
// Fixtures are made-up placeholders, not the real menu. Only the two slugs suggestions look for are real.
const test = require("node:test");
const assert = require("node:assert/strict");
const { suggestItems } = require("./recommendations");
const { createOrderState, addToCart } = require("./order-session");
const { getOrderableMenu } = require("./menu-tool");
const menuService = require("./services/menu-service");
const { PRICE } = require("./fake-menu");

const item = (id, category_id, name, is_available = true, sort_order = 1) => ({
  id, category_id, slug: id, name, description: null, price_paisa: PRICE.item, sort_order, image_url: null, is_available,
});

const TABLES = {
  menu_categories: [
    { id: "c-main", slug: "mains", name: "Mains", sort_order: 1, image_url: null },
    { id: "c-drinks", slug: "drinks", name: "Drinks", sort_order: 2, image_url: null },
    { id: "c-fries", slug: "fries", name: "Fries", sort_order: 3, image_url: null },
  ],
  menu_items: [
    item("main", "c-main", "Test Main"),
    item("main-with-fries", "c-main", "Test Box with Fries"),
    item("drink-off", "c-drinks", "Test Soda Finished", false),
    item("cola", "c-drinks", "Test Cola", true, 2),
    item("juice", "c-drinks", "Test Juice", true, 3),
    item("chips", "c-fries", "Test Chips"),
  ],
  menu_deals: [
    { id: "deal-linked", slug: "deal-linked", name: "Deal Linked", price_paisa: PRICE.combo, sort_order: 1 },
    { id: "deal-labels", slug: "deal-labels", name: "Deal Labels", price_paisa: PRICE.combo, sort_order: 2 },
    { id: "deal-food", slug: "deal-food", name: "Deal Food", price_paisa: PRICE.combo, sort_order: 3 },
  ],
  menu_deal_items: [
    { deal_id: "deal-linked", label: "1 Test Main", item_id: "main", quantity: 1, sort_order: 1 },
    { deal_id: "deal-linked", label: "1 Bottle", item_id: "cola", quantity: 1, sort_order: 2 },
    { deal_id: "deal-labels", label: "1 Fries", item_id: null, quantity: 1, sort_order: 1 },
    { deal_id: "deal-labels", label: "500ml Drink", item_id: null, quantity: 1, sort_order: 2 },
    { deal_id: "deal-food", label: "1 Test Main", item_id: "main", quantity: 1, sort_order: 1 },
  ],
  menu_settings: [],
};

function useTables(tables) {
  menuService.setClient({
    from(table) {
      const query = { select: () => query, eq: () => query, order: () => query, then: (resolve) => resolve({ data: tables[table] || [], error: null }) };
      return query;
    },
  });
}

function cartWith(...itemIds) {
  const state = createOrderState();
  state.items = itemIds.map((item_id) => ({ item_id, quantity: 1, option_ids: [] }));
  return state;
}

const ids = (suggestions) => suggestions.map((s) => s.itemId);

test.beforeEach(() => useTables(TABLES));

test("an empty cart gets no suggestions", async () => {
  assert.deepEqual(suggestItems(createOrderState(), await getOrderableMenu()), []);
});

test("a cart with neither gets a drink and fries from the live menu, at their menu prices", async () => {
  const suggestions = suggestItems(cartWith("main"), await getOrderableMenu());
  assert.deepEqual(ids(suggestions), ["cola", "chips"]);
  assert.equal(suggestions[0].name, "Test Cola");
  assert.equal(suggestions[0].pricePaisa, PRICE.item);
});

test("a drink or fries already in the cart means no suggestion", async () => {
  const menu = await getOrderableMenu();
  assert.deepEqual(suggestItems(cartWith("main", "juice"), menu), []);
  assert.deepEqual(suggestItems(cartWith("main", "chips"), menu), []);
});

test("an item that comes with fries counts as having fries", async () => {
  assert.deepEqual(suggestItems(cartWith("main-with-fries"), await getOrderableMenu()), []);
});

test("a deal holding a drink counts, whether it's linked to the item or only named in a label", async () => {
  const menu = await getOrderableMenu();
  assert.deepEqual(suggestItems(cartWith("deal-linked"), menu), [], "linked to a drinks item");
  assert.deepEqual(suggestItems(cartWith("deal-labels"), menu), [], "unlinked labels");
  assert.deepEqual(ids(suggestItems(cartWith("deal-food"), menu)), ["cola", "chips"], "a deal with neither gets both");
});

test("each kind is offered only once per chat", async () => {
  const menu = await getOrderableMenu();
  const state = cartWith("main");
  assert.equal(suggestItems(state, menu).length, 2);
  assert.deepEqual(suggestItems(state, menu), []);
});

test("an unavailable item is never suggested", async () => {
  const menu = await getOrderableMenu();
  assert.ok(!ids(suggestItems(cartWith("main"), menu)).includes("drink-off"));

  useTables({ ...TABLES, menu_items: TABLES.menu_items.map((row) => (row.category_id === "c-drinks" ? { ...row, is_available: false } : row)) });
  assert.deepEqual(ids(suggestItems(cartWith("main"), await getOrderableMenu())), ["chips"], "no drink left, and none invented");
});

test("a missing category suggests nothing from it and says so in the log", async () => {
  useTables({ ...TABLES, menu_categories: TABLES.menu_categories.filter((c) => c.slug !== "fries") });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (text) => warnings.push(text);
  try {
    assert.deepEqual(ids(suggestItems(cartWith("main"), await getOrderableMenu())), ["cola"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ['Suggestions: the menu has no "fries" category.']);
});

test("unknown ids and a broken menu suggest nothing invented", async () => {
  assert.deepEqual(ids(suggestItems(cartWith("made-up-item"), await getOrderableMenu())), ["cola", "chips"]);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(suggestItems(cartWith("main"), { categories: "broken" }), []);
  } finally {
    console.warn = originalWarn;
  }
});

test("a new cart after a saved order keeps what was already offered", async () => {
  const menu = await getOrderableMenu();
  const state = cartWith("main");
  suggestItems(state, menu);
  state.status = "saved";
  addToCart(state, { item_id: "main", quantity: 1, option_ids: [] });
  assert.equal(state.items.length, 1);
  assert.deepEqual(suggestItems(state, menu), []);
});
