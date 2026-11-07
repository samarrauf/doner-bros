// The single reader of menu data. Everything comes from Supabase through the server-side client
// passed to setClient; nothing here accepts a price from a caller.

const CACHE_TTL_MS = 60 * 1000;

// The only settings /api/menu may return. A setting not named here stays private.
const PUBLIC_SETTING_KEYS = [
  "currency",
  "order_types",
  "whatsapp",
  "address",
  "tax_mode",
  "tax_rate_bps",
  "delivery_fee_paisa",
  "hero_image_url",
  "brand_logo_url",
];

let client = null;
let cache = null;
let inFlight = null;
// Bumped by refreshMenu, so a load that started before a refresh can't refill the cache with old data.
let generation = 0;

function setClient(supabaseClient) {
  client = supabaseClient;
  refreshMenu();
}

function refreshMenu() {
  cache = null;
  inFlight = null;
  generation += 1;
}

// Whole-number arithmetic only: 29000 -> "Rs 290", 29050 -> "Rs 290.50".
function formatPrice(paisa) {
  const rupees = Math.floor(paisa / 100).toLocaleString("en-PK");
  const remainder = paisa % 100;
  return remainder === 0 ? `Rs ${rupees}` : `Rs ${rupees}.${String(remainder).padStart(2, "0")}`;
}

function toItem(row) {
  return {
    id: row.id,
    categoryId: row.category_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    pricePaisa: row.price_paisa,
    priceDisplay: formatPrice(row.price_paisa),
    imageUrl: row.image_url || null,
    isAvailable: row.is_available === true,
  };
}

// Cached data is shared between requests, so a caller must not be able to change it.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function buildSnapshot({ categoryRows, itemRows, dealRows, dealItemRows, settingRows }) {
  const items = itemRows.map(toItem);
  const categories = categoryRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    imageUrl: row.image_url || null,
    items: items.filter((item) => item.categoryId === row.id && item.isAvailable),
  }));
  // An item in an inactive category is not on the menu, so it can't be found or ordered either.
  const activeCategoryIds = new Set(categoryRows.map((row) => row.id));
  const itemsById = new Map(items.filter((item) => activeCategoryIds.has(item.categoryId)).map((item) => [item.id, item]));
  const deals = dealRows.map((row) => {
    const dealItems = dealItemRows
      .filter((dealItem) => dealItem.deal_id === row.id)
      .map((dealItem) => ({ label: dealItem.label, itemId: dealItem.item_id, quantity: dealItem.quantity }));
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      pricePaisa: row.price_paisa,
      priceDisplay: formatPrice(row.price_paisa),
      items: dealItems,
      // Only linked items can be checked. A linked item that is off the menu makes the deal unavailable.
      isAvailable: dealItems.every((dealItem) => !dealItem.itemId || itemsById.get(dealItem.itemId)?.isAvailable === true),
    };
  });
  const settings = Object.fromEntries(settingRows.map((row) => [row.key, row.value]));
  const fetchedAtMs = Date.now();

  deepFreeze(items);
  deepFreeze(categories);
  deepFreeze(deals);
  deepFreeze(settings);
  return { categories, deals, settings, itemsById, fetchedAtMs };
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function fetchSnapshot() {
  const [categoryRows, itemRows, dealRows, dealItemRows, settingRows] = await Promise.all([
    rows(client.from("menu_categories").select("id, slug, name, sort_order, image_url").eq("is_active", true).order("sort_order").order("name")),
    rows(client.from("menu_items").select("id, category_id, slug, name, description, price_paisa, sort_order, image_url, is_available").order("sort_order").order("name")),
    rows(client.from("menu_deals").select("id, slug, name, price_paisa, sort_order").eq("is_active", true).order("sort_order").order("name")),
    rows(client.from("menu_deal_items").select("deal_id, label, item_id, quantity, sort_order").order("sort_order").order("label")),
    rows(client.from("menu_settings").select("key, value")),
  ]);
  return buildSnapshot({ categoryRows, itemRows, dealRows, dealItemRows, settingRows });
}

function unavailable() {
  const error = new Error("The menu could not be loaded.");
  error.code = "MENU_UNAVAILABLE";
  return error;
}

async function fetchWithRetry() {
  if (!client) {
    console.error("Menu load skipped: Supabase is not configured.");
    throw unavailable();
  }
  try {
    return await fetchSnapshot();
  } catch (error) {
    console.error("Menu load failed, retrying once:", error.code || error.message);
  }
  try {
    return await fetchSnapshot();
  } catch (error) {
    console.error("Menu load failed after retry:", error.code || error.message);
    throw unavailable();
  }
}

// Concurrent requests on a cache miss share one load.
function loadSnapshot() {
  if (cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) return Promise.resolve(cache);
  if (!inFlight) {
    const startedIn = generation;
    const load = fetchWithRetry()
      .then((snapshot) => {
        if (startedIn === generation) cache = snapshot;
        return snapshot;
      })
      .finally(() => {
        if (inFlight === load) inFlight = null;
      });
    inFlight = load;
  }
  return inFlight;
}

async function getMenu() {
  return (await loadSnapshot()).categories;
}

// Unknown id: null. Known but finished for now: the item, with isAvailable false.
async function getItemById(id) {
  return (await loadSnapshot()).itemsById.get(id) || null;
}

async function getItemsByIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError("getItemsByIds needs an array of ids.");
  const { itemsById } = await loadSnapshot();
  return {
    items: ids.filter((id) => itemsById.has(id)).map((id) => itemsById.get(id)),
    missingIds: ids.filter((id) => !itemsById.has(id)),
  };
}

async function getDeals() {
  return (await loadSnapshot()).deals;
}

async function getSettings() {
  return (await loadSnapshot()).settings;
}

// A setting not in PUBLIC_SETTING_KEYS stays private. getPublicMenu passes its snapshot in.
async function getPublicSettings(snapshot) {
  const { settings } = snapshot || (await loadSnapshot());
  const publicSettings = {};
  for (const key of PUBLIC_SETTING_KEYS) {
    if (Object.hasOwn(settings, key)) publicSettings[key] = settings[key];
  }
  return publicSettings;
}

// Every word of the search must appear in the item's name, in any order, ignoring case.
async function findItems(searchText) {
  const { itemsById } = await loadSnapshot();
  if (typeof searchText !== "string") return [];
  const words = searchText.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return [...itemsById.values()].filter((item) => {
    const name = item.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

// One snapshot for the whole response, so its parts can't straddle a cache refresh.
async function getPublicMenu() {
  const snapshot = await loadSnapshot();
  const { categories, deals, fetchedAtMs } = snapshot;
  return {
    categories,
    deals: deals.filter((deal) => deal.isAvailable),
    settings: await getPublicSettings(snapshot),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
}

// For the staff photo screen. Includes finished items, which still need photos, and skips the cache,
// so a reload always shows what was just uploaded.
async function getPhotoChecklist() {
  const snapshot = await fetchWithRetry();
  const { hero_image_url: heroImageUrl, brand_logo_url: logoImageUrl } = await getPublicSettings(snapshot);
  const items = [...snapshot.itemsById.values()];
  return {
    categories: snapshot.categories.map((category) => ({
      id: category.id,
      name: category.name,
      items: items
        .filter((item) => item.categoryId === category.id)
        .map(({ id, name, imageUrl, isAvailable }) => ({ id, name, imageUrl, isAvailable })),
    })),
    heroImageUrl: heroImageUrl || null,
    logoImageUrl: logoImageUrl || null,
  };
}

async function getHealth() {
  const { categories, fetchedAtMs } = await loadSnapshot();
  const itemCount = categories.reduce((count, category) => count + category.items.length, 0);
  return { itemCount, cacheAgeMs: Date.now() - fetchedAtMs };
}

module.exports = {
  formatPrice,
  setClient,
  refreshMenu,
  getMenu,
  getItemById,
  getItemsByIds,
  getDeals,
  getSettings,
  getPublicSettings,
  findItems,
  getPublicMenu,
  getPhotoChecklist,
  getHealth,
};
