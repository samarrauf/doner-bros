// Tests for the menu tools. Run with: npm test
// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const menuService = require("./services/menu-service");
const { MENU_TOOLS, MENU_TOOL_NAMES, runMenuTool, getOrderableMenu } = require("./menu-tool");
const { priceCart } = require("./totals");

const TABLES = {
  menu_categories: [
    { id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null },
    { id: "cat-b", slug: "beta", name: "Beta", sort_order: 2, image_url: null },
  ],
  menu_items: [
    { id: "i-1", category_id: "cat-a", slug: "red-widget", name: "Red Widget", description: null, price_paisa: 12300, sort_order: 1, image_url: null, is_available: true },
    { id: "i-2", category_id: "cat-a", slug: "blue-widget", name: "Blue Widget", description: "Test", price_paisa: 45600, sort_order: 2, image_url: null, is_available: false },
    { id: "i-3", category_id: "cat-b", slug: "green-gadget", name: "Green Gadget", description: null, price_paisa: 78900, sort_order: 1, image_url: null, is_available: true },
  ],
  menu_deals: [
    { id: "d-1", slug: "test-deal", name: "Test Deal", price_paisa: 11100, sort_order: 1 },
    { id: "d-2", slug: "off-deal", name: "Off Deal", price_paisa: 22200, sort_order: 2 },
  ],
  menu_deal_items: [
    { deal_id: "d-1", label: "1 Red Widget", item_id: "i-1", quantity: 1, sort_order: 1 },
    { deal_id: "d-1", label: "1 Extra", item_id: null, quantity: 1, sort_order: 2 },
    { deal_id: "d-2", label: "1 Blue Widget", item_id: "i-2", quantity: 1, sort_order: 1 },
  ],
  menu_settings: [],
};

function fakeClient(tables, error = null) {
  return {
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve) => resolve({ data: error ? null : tables[table] || [], error }),
      };
      return query;
    },
  };
}

test.beforeEach(() => menuService.setClient(fakeClient(TABLES)));

test("exposes exactly the five menu tools, none of which takes a price", () => {
  assert.deepEqual(MENU_TOOL_NAMES, ["list_categories", "list_items", "search_items", "get_item", "list_deals"]);
  for (const tool of MENU_TOOLS) {
    const inputs = Object.keys(tool.parametersJsonSchema?.properties || {});
    assert.ok(!inputs.some((name) => /price|paisa|amount|total/i.test(name)), `${tool.name} takes a price`);
  }
});

test("list_categories returns slugs and counts, and no prices", async () => {
  const result = await runMenuTool("list_categories");
  assert.deepEqual(result.categories[0], { slug: "alpha", name: "Alpha", itemCount: 1 });
  assert.ok(!JSON.stringify(result).includes("rice"));
});

test("list_items returns ids, names and paisa prices for that category only", async () => {
  const result = await runMenuTool("list_items", { category_slug: "alpha" });
  assert.deepEqual(result.items.map((item) => [item.id, item.name, item.pricePaisa]), [["i-1", "Red Widget", 12300]]);
  assert.equal(result.items[0].priceDisplay, "Rs 123");
});

test("list_items with an unknown slug finds nothing and names the real slugs", async () => {
  assert.deepEqual(await runMenuTool("list_items", { category_slug: "nope" }), { found: false, categories: ["alpha", "beta"] });
});

test("search_items finds by name", async () => {
  const result = await runMenuTool("search_items", { text: "green gadget" });
  assert.equal(result.found, true);
  assert.deepEqual(result.items.map((item) => item.id), ["i-3"]);
});

test("search_items with no full match gives real, available close matches", async () => {
  const result = await runMenuTool("search_items", { text: "purple widget" });
  assert.equal(result.found, false);
  assert.deepEqual(result.closeMatches.map((item) => item.id), ["i-1"]);
  assert.deepEqual(await runMenuTool("search_items", { text: "zzz" }), { found: false, closeMatches: [] });
});

test("get_item returns the item, or not found", async () => {
  const result = await runMenuTool("get_item", { item_id: "i-2" });
  assert.equal(result.item.pricePaisa, 45600);
  assert.equal(result.item.available, false);
  assert.deepEqual(await runMenuTool("get_item", { item_id: "nope" }), { found: false });
});

test("list_deals gives only available deals, with their contents", async () => {
  const { deals } = await runMenuTool("list_deals");
  assert.deepEqual(deals, [
    {
      id: "d-1",
      name: "Test Deal",
      pricePaisa: 11100,
      priceDisplay: "Rs 111",
      items: [
        { itemId: "i-1", name: "1 Red Widget", quantity: 1 },
        { itemId: null, name: "1 Extra", quantity: 1 },
      ],
    },
  ]);
});

test("a failed read tells the model to give up on the menu, with no items", async () => {
  menuService.setClient(fakeClient(TABLES, new Error("down")));
  for (const name of MENU_TOOL_NAMES) {
    const result = await runMenuTool(name, { category_slug: "alpha", text: "red", item_id: "i-1" });
    assert.equal(result.error, "menu_unavailable", name);
    assert.ok(!JSON.stringify(result).includes("Widget"));
  }
});

test("the cart prices items and deals from the service, and refuses anything else", async () => {
  assert.equal((await priceCart([{ item_id: "i-1", quantity: 2 }])).lines[0].lineTotalPaisa, 24600);
  assert.equal((await priceCart([{ item_id: "d-1", quantity: 1 }])).lines[0].unitPricePaisa, 11100);
  assert.ok((await priceCart([{ item_id: "i-2", quantity: 1 }])).error, "a finished item can't be ordered");
  assert.ok((await priceCart([{ item_id: "d-2", quantity: 1 }])).error, "an unavailable deal can't be ordered");
  assert.ok((await priceCart([{ item_id: "nope", quantity: 1 }])).error);
  const pricedAnyway = await priceCart([{ item_id: "i-1", quantity: 1, pricePaisa: 1 }]);
  assert.equal(pricedAnyway.lines[0].unitPricePaisa, 12300, "a price passed in is ignored");
});

test("the chatbot files don't read the old menu or restaurant files", () => {
  for (const file of ["menu-tool.js", "server.js", "price-guard.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(!source.includes("menu.json"), `${file} reads menu.json`);
    assert.ok(!source.includes("restaurant.json"), `${file} reads restaurant.json`);
  }
});

test("the system prompt holds no rupee amounts except the one format example", () => {
  const prompt = fs.readFileSync(path.join(__dirname, "..", "prompts", "system-prompt.md"), "utf8");
  assert.deepEqual([...new Set(prompt.match(/Rs\.? ?\d[\d,]*/g))], ["Rs 290"]);
  assert.ok(!/\d{4}-?\d{7}/.test(prompt), "no phone number in the prompt");
});
