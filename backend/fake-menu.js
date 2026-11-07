// For tests only: serves made-up placeholder data through the real menu service, so tests exercise
// the same path as the app without touching Supabase or holding any real menu data.

const menuService = require("./services/menu-service");

const NO_TAX = { tax_mode: "none", tax_rate_bps: "0", delivery_fee_paisa: "0" };

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
  row("i-main", "Test Main", 75000),
  row("i-side", "Test Side", 35000),
  row("i-drink", "Test Drink", 15000),
  row("i-finished", "Test Finished", 50000, false),
  // Named for the one item the sample offers in data/promotions.json apply to.
  row("loaded-bro-box", "Test Box", 125000),
];

function tables({ settings, items }) {
  return {
    menu_categories: [{ id: "cat-a", slug: "alpha", name: "Alpha", sort_order: 1, image_url: null }],
    menu_items: items,
    menu_deals: [
      { id: "d-combo", slug: "d-combo", name: "Test Combo", price_paisa: 90000, sort_order: 1 },
      { id: "d-gone", slug: "d-gone", name: "Test Gone", price_paisa: 40000, sort_order: 2 },
    ],
    menu_deal_items: [
      { deal_id: "d-combo", label: "Test Main", item_id: "i-main", quantity: 1, sort_order: 1 },
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

module.exports = { useFakeMenu, NO_TAX };
