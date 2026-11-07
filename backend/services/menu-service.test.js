// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");
const menuService = require("./menu-service");

// Stops server.js binding its own PORT on load; these tests listen on a free port below.
process.env.VERCEL = "1";
const app = require("../server");

const CATEGORY = { id: "cat-open", slug: "open", name: "Open category", sort_order: 1, image_url: null };

function itemRow(id, overrides = {}) {
  return {
    id,
    category_id: CATEGORY.id,
    slug: id,
    name: `Test ${id}`,
    description: null,
    price_paisa: 12345,
    sort_order: 1,
    image_url: null,
    is_available: true,
    ...overrides,
  };
}

function dealRow(id) {
  return { id, slug: id, name: `Deal ${id}`, price_paisa: 54321, sort_order: 1 };
}

function dealItemRow(dealId, itemId, label = "Test label") {
  return { deal_id: dealId, label, item_id: itemId, quantity: 1, sort_order: 1 };
}

// Stands in for the Supabase query builder: every chained call returns the same thenable.
function fakeClient(tables = {}, { error = null } = {}) {
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

function useTables(tables) {
  menuService.setClient(fakeClient({ menu_categories: [CATEGORY], ...tables }));
}

let baseUrl;
let server;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  menuService.setClient(null);
  await new Promise((resolve) => server.close(resolve));
});

async function getApiMenu() {
  const response = await fetch(`${baseUrl}/api/menu`);
  return { status: response.status, body: await response.json() };
}

// 1. Public settings

test("/api/menu returns every allow-listed setting that exists", async () => {
  const keys = ["currency", "order_types", "whatsapp", "address", "tax_mode", "tax_rate_bps", "delivery_fee_paisa", "hero_image_url", "brand_logo_url"];
  useTables({ menu_settings: keys.map((key) => ({ key, value: `value-${key}` })) });

  const { body } = await getApiMenu();

  assert.deepEqual(Object.keys(body.settings).sort(), [...keys].sort());
  assert.equal(body.settings.currency, "value-currency");
});

test("/api/menu never returns an unlisted setting, whatever it is called", async () => {
  useTables({
    menu_settings: [
      { key: "currency", value: "value-currency" },
      { key: "internal_margin_bps", value: "secret-value-1" },
      { key: "whatsapp_api_token", value: "secret-value-2" },
      { key: "Currency", value: "secret-value-3" },
    ],
  });

  const response = await fetch(`${baseUrl}/api/menu`);
  const text = await response.text();

  assert.deepEqual(JSON.parse(text).settings, { currency: "value-currency" });
  assert.ok(!text.includes("secret-value"));
  assert.ok(!text.includes("internal_margin_bps"));
  assert.ok(!text.includes("whatsapp_api_token"));
});

test("an allow-listed setting that is not in the table is simply absent", async () => {
  useTables({ menu_settings: [] });
  assert.deepEqual((await getApiMenu()).body.settings, {});
});

test("getSettings still gives the backend the private settings", async () => {
  useTables({ menu_settings: [{ key: "internal_margin_bps", value: "1" }] });
  assert.equal((await menuService.getSettings()).internal_margin_bps, "1");
});

// 2. Unavailable versus unknown items

const finishedAndOpen = {
  menu_items: [itemRow("open"), itemRow("finished", { is_available: false, name: "Test finished thing" })],
};

test("getItemById tells a finished item from an unknown one", async () => {
  useTables(finishedAndOpen);

  const finished = await menuService.getItemById("finished");
  assert.equal(finished.isAvailable, false);
  assert.equal(finished.name, "Test finished thing");
  assert.equal(finished.pricePaisa, 12345);

  assert.equal((await menuService.getItemById("open")).isAvailable, true);
  assert.equal(await menuService.getItemById("no-such-id"), null);
});

test("getItemsByIds returns finished items flagged and leaves out unknown ids", async () => {
  useTables(finishedAndOpen);

  const items = await menuService.getItemsByIds(["finished", "no-such-id", "open"]);

  assert.deepEqual(items.map((item) => [item.id, item.isAvailable]), [["finished", false], ["open", true]]);
});

test("findItems finds finished items, flagged", async () => {
  useTables(finishedAndOpen);

  const found = await menuService.findItems("finished");

  assert.deepEqual(found.map((item) => [item.id, item.isAvailable]), [["finished", false]]);
  assert.deepEqual(await menuService.findItems("no such words"), []);
});

test("public browsing leaves out finished items", async () => {
  useTables(finishedAndOpen);

  const menu = await menuService.getMenu();
  assert.deepEqual(menu[0].items.map((item) => item.id), ["open"]);

  const { body } = await getApiMenu();
  assert.deepEqual(body.categories[0].items.map((item) => item.id), ["open"]);
  assert.equal((await menuService.getHealth()).itemCount, 1);
});

test("an item in an inactive category still counts as unknown", async () => {
  useTables({ menu_items: [itemRow("hidden", { category_id: "cat-inactive" })] });
  assert.equal(await menuService.getItemById("hidden"), null);
});

test("a finished item from the shared cache can't be changed by a caller", async () => {
  useTables(finishedAndOpen);
  assert.ok(Object.isFrozen(await menuService.getItemById("finished")));
});

// 3. Deals

const dealTables = {
  menu_items: [
    itemRow("open"),
    itemRow("finished", { is_available: false }),
    itemRow("hidden", { category_id: "cat-inactive" }),
  ],
  menu_deals: [dealRow("all-open"), dealRow("one-finished"), dealRow("labels-only"), dealRow("hidden-item"), dealRow("mixed-open"), dealRow("mixed-finished")],
  menu_deal_items: [
    dealItemRow("all-open", "open"),
    dealItemRow("one-finished", "open"),
    dealItemRow("one-finished", "finished"),
    dealItemRow("labels-only", null),
    dealItemRow("hidden-item", "hidden"),
    dealItemRow("mixed-open", "open"),
    dealItemRow("mixed-open", null),
    dealItemRow("mixed-finished", "finished"),
    dealItemRow("mixed-finished", null),
  ],
};

test("each deal's isAvailable is computed from its linked items", async () => {
  useTables(dealTables);

  const flags = Object.fromEntries((await menuService.getDeals()).map((deal) => [deal.id, deal.isAvailable]));

  assert.deepEqual(flags, {
    "all-open": true,
    "one-finished": false,
    "labels-only": true,
    "hidden-item": false,
    "mixed-open": true,
    "mixed-finished": false,
  });
});

test("/api/menu excludes unavailable deals", async () => {
  useTables(dealTables);

  const { body } = await getApiMenu();

  assert.deepEqual(body.deals.map((deal) => deal.id), ["all-open", "labels-only", "mixed-open"]);
  assert.ok(body.deals.every((deal) => deal.isAvailable === true));
});

// The 503 behaviour stays as it was

test("a failed read is a 503 carrying no menu data", async () => {
  useTables(finishedAndOpen);
  assert.equal((await getApiMenu()).status, 200);

  menuService.setClient(fakeClient({}, { error: { code: "TEST_FAILURE" } }));
  const { status, body } = await getApiMenu();

  assert.equal(status, 503);
  assert.deepEqual(Object.keys(body), ["error"]);
});
