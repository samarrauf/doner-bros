// For tests only: serves made-up placeholder data through the real menu service, so tests exercise
// the same path as the app without touching Supabase or holding any real menu data.
// This is the one place test prices live; tests read them from here and work out what they expect.

const menuService = require("./services/menu-service");

// Made-up amounts, none of them a real menu price. Multiples of Rs 25, so 16% tax is whole rupees.
const PRICE = {
  main: 77500,
  side: 32500,
  drink: 12500,
  finished: 52500,
  box: 127500,
  combo: 92500,
  gone: 42500,
  // Standalone item for tests that build their own tables, and a second one for items in those tables.
  item: 12300,
  other: 45600,
  third: 78900,
  otherCombo: 22200,
  // What an item costs after a test changes the menu.
  changed: 98500,
  // Amounts no tool ever returns: what a model might invent or a customer might suggest.
  invented: 99900,
  inventedAgain: 99800,
  suggested: 5000,
  // Bigger than the orders table can hold once multiplied by a quantity.
  tooBig: 2000000000,
};

const FEE = 17500;
const DISCOUNT = 17000;

// Inputs for the tax rounding arithmetic, with the tax each must give.
const TAX_ROUNDING = [
  { price: 12500, bps: 1600, tax: 2000 },
  { price: 10300, bps: 500, tax: 500 }, // Rs 5.15 rounds down
  { price: 11000, bps: 500, tax: 600 }, // Rs 5.50 rounds up
];

const NO_TAX = { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: "0" };
const TAXED = { tax_mode: "exclusive", tax_rate_bps: "1600", delivery_fee_paisa: String(FEE) };

const rs = menuService.formatPrice;
// Tax is charged to the nearest whole rupee.
const wholeRupees = (paisa) => Math.round(paisa / 100) * 100;

const row = (id, name, price_paisa, is_available = true) => ({
  id,
  category_id: "cat-a",
  slug: id,
  name,
  description: null,
  price_paisa,
  sort_order: 1,
  image_url: null,
  is_available,
});

const ITEMS = [
  row("i-main", "Test Main", PRICE.main),
  row("i-side", "Test Side", PRICE.side),
  row("i-drink", "Test Drink", PRICE.drink),
  row("i-finished", "Test Finished", PRICE.finished, false),
  // The one item PICKUP_FIXED below applies to.
  row("i-box", "Test Box", PRICE.box),
];

function tables({ settings, items }) {
  return {
    menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
    menu_items: items,
    menu_deals: [
      { id: "d-combo", slug: "d-combo", name: "Test Combo", price_paisa: PRICE.combo, sort_order: 1 },
      { id: "d-gone", slug: "d-gone", name: "Test Gone", price_paisa: PRICE.gone, sort_order: 2 },
    ],
    menu_deal_items: [
      // Its parts add up to more than the deal costs, so a deal priced by its parts is caught.
      { deal_id: "d-combo", label: "1 Test Main", item_id: "i-main", quantity: 1, sort_order: 1 },
      { deal_id: "d-combo", label: "1 Test Side", item_id: "i-side", quantity: 1, sort_order: 2 },
      { deal_id: "d-combo", label: "1 Test Extra", item_id: null, quantity: 1, sort_order: 3 },
      { deal_id: "d-gone", label: "Test Finished", item_id: "i-finished", quantity: 1, sort_order: 1 },
    ],
    menu_settings: Object.entries(settings).map(([key, value]) => ({ key, value })),
  };
}

// settings replace the no-tax defaults; prices maps an item id to a new price, as a later menu change would.
function useFakeMenu({ settings = NO_TAX, prices = {}, extra = {} } = {}) {
  const items = ITEMS.map((item) => (prices[item.id] ? { ...item, price_paisa: prices[item.id] } : item));
  const data = tables({ settings: { ...settings, ...extra }, items });
  menuService.setClient({
    from(table) {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve) => resolve({ data: data[table] || [], error: null }),
      };
      return query;
    },
  });
}

// Made-up promotions, so the promotion rules can be tested while no real ones exist.
const PERCENT = {
  id: "test-percent",
  name: "Test 10% off",
  active: true,
  code: "TEST10",
  description: "10% off orders of Rs 2,000 or more.",
  discount: { type: "percent", value: 10 },
  conditions: { minOrderPaisa: 200000, orderTypes: ["pickup", "delivery"], startDate: "2026-01-01", endDate: "2026-12-31" },
};
const PICKUP_FIXED = {
  id: "test-pickup-fixed",
  name: "Test pickup offer",
  active: true,
  code: null,
  description: "Rs 100 off each Test Box on pickup orders, Mondays only.",
  discount: { type: "fixedPaisa", valuePaisa: 10000, perItem: true },
  conditions: { orderTypes: ["pickup"], itemIds: ["i-box"], daysOfWeek: ["Monday"], startDate: "2026-01-01", endDate: "2026-12-31" },
};
const EXPIRED = {
  id: "test-expired",
  name: "Test expired offer",
  active: true,
  code: "OLD5",
  description: "An offer that has already ended.",
  discount: { type: "percent", value: 5 },
  conditions: { orderTypes: ["pickup", "delivery"], startDate: "2025-01-01", endDate: "2025-12-31" },
};

module.exports = { useFakeMenu, NO_TAX, TAXED, PRICE, FEE, DISCOUNT, TAX_ROUNDING, rs, wholeRupees, PERCENT, PICKUP_FIXED, EXPIRED };
