// Fixtures are made-up placeholders, not the real menu. Supabase stays the only source of menu data.
const test = require("node:test");
const assert = require("node:assert/strict");
const menuService = require("./menu-service");
const { PRICE, useFakeMenu } = require("../fake-menu");

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
    price_paisa: PRICE.item,
    sort_order: 1,
    image_url: null,
    is_available: true,
    ...overrides,
  };
}

function dealRow(id) {
  return { id, slug: id, name: `Deal ${id}`, price_paisa: PRICE.combo, sort_order: 1 };
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

test("getPublicSettings never returns a key outside the list", async () => {
  const allowed = ["currency", "order_types", "whatsapp", "address", "tax_mode", "tax_rate_bps", "delivery_fee_paisa", "hero_image_url", "brand_logo_url"];
  const unlisted = ["internal_margin_bps", "whatsapp_api_token", "Currency", "currency ", "__proto__", "constructor"];
  useTables({ menu_settings: [...allowed, ...unlisted].map((key) => ({ key, value: `value-${key}` })) });

  const publicSettings = await menuService.getPublicSettings();

  assert.deepEqual(Object.keys(publicSettings).sort(), [...allowed].sort());
  assert.deepEqual((await getApiMenu()).body.settings, publicSettings);
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
  assert.equal(finished.pricePaisa, PRICE.item);

  assert.equal((await menuService.getItemById("open")).isAvailable, true);
  assert.equal(await menuService.getItemById("no-such-id"), null);
});

test("getItemsByIds returns finished items flagged and reports unknown ids", async () => {
  useTables(finishedAndOpen);

  const { items, missingIds } = await menuService.getItemsByIds(["finished", "no-such-id", "open"]);

  assert.deepEqual(items.map((item) => [item.id, item.isAvailable]), [["finished", false], ["open", true]]);
  assert.deepEqual(missingIds, ["no-such-id"]);
});

test("getItemsByIds accounts for every id it is given", async () => {
  useTables(finishedAndOpen);
  const ids = ["open", "open", "gone-1", "gone-1", null, "finished"];

  const { items, missingIds } = await menuService.getItemsByIds(ids);

  assert.equal(items.length + missingIds.length, ids.length);
  assert.deepEqual(missingIds, ["gone-1", "gone-1", null]);
  assert.deepEqual(await menuService.getItemsByIds([]), { items: [], missingIds: [] });
});

test("getItemsByIds reports an item in an inactive category as missing", async () => {
  useTables({ menu_items: [itemRow("hidden", { category_id: "cat-inactive" })] });
  assert.deepEqual(await menuService.getItemsByIds(["hidden"]), { items: [], missingIds: ["hidden"] });
});

test("getItemsByIds refuses anything that is not a list of ids", async () => {
  useTables(finishedAndOpen);
  await assert.rejects(menuService.getItemsByIds("open"), TypeError);
  await assert.rejects(menuService.getItemsByIds(undefined), TypeError);
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

// 4. What the site gets

test("/api/menu returns the expected category and item counts", async () => {
  useFakeMenu(); // One category, five items of which one is finished, two deals of which one is unavailable.

  const { status, body } = await getApiMenu();

  assert.equal(status, 200);
  assert.equal(body.categories.length, 1);
  assert.equal(body.categories[0].items.length, 4);
  assert.equal(body.deals.length, 1);
});

test("a price changed in Supabase appears in /api/menu after the cache expires", async () => {
  const row = itemRow("open", { price_paisa: PRICE.item });
  useTables({ menu_items: [row] });
  const shownPrice = async () => (await getApiMenu()).body.categories[0].items[0].pricePaisa;

  assert.equal(await shownPrice(), PRICE.item);

  row.price_paisa = PRICE.changed;
  assert.equal(await shownPrice(), PRICE.item, "still cached");

  const realNow = Date.now;
  Date.now = () => realNow() + menuService.CACHE_TTL_MS + 1;
  try {
    assert.equal(await shownPrice(), PRICE.changed);
  } finally {
    Date.now = realNow;
  }
});

// The 503 behaviour stays as it was

test("the photo checklist includes finished items, leaves out inactive categories, and isn't cached", async () => {
  const itemRows = [
    itemRow("on-sale", { image_url: "https://storage.test/a.webp" }),
    itemRow("finished", { is_available: false }),
    itemRow("hidden", { category_id: "cat-closed" }),
  ];
  useTables({
    menu_items: itemRows,
    menu_settings: [
      { key: "hero_image_url", value: "https://storage.test/hero.webp" },
      { key: "brand_logo_url", value: "" },
      { key: "private_setting", value: "secret" },
    ],
  });
  assert.deepEqual(await menuService.getPhotoChecklist(), {
    categories: [{
      id: CATEGORY.id,
      name: CATEGORY.name,
      items: [
        { id: "on-sale", name: "Test on-sale", imageUrl: "https://storage.test/a.webp", isAvailable: true },
        { id: "finished", name: "Test finished", imageUrl: null, isAvailable: false },
      ],
    }],
    heroImageUrl: "https://storage.test/hero.webp",
    logoImageUrl: null,
  });

  await menuService.getMenu(); // Fills the cache before the photo changes.
  itemRows[0].image_url = "https://storage.test/new.webp";
  const after = await menuService.getPhotoChecklist();
  assert.equal(after.categories[0].items[0].imageUrl, "https://storage.test/new.webp");
});

test("a failed read is a 503 carrying no menu data", async () => {
  useTables(finishedAndOpen);
  assert.equal((await getApiMenu()).status, 200);

  menuService.setClient(fakeClient({}, { error: { code: "TEST_FAILURE" } }));
  const { status, body } = await getApiMenu();

  assert.equal(status, 503);
  assert.deepEqual(Object.keys(body), ["error"]);
});
