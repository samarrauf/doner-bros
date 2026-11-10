// Doner Bros — the menu tools the chat model can call. Every lookup goes through the menu service, which
// reads Supabase. No tool takes a price as input; prices only ever come out of the service.

const menuService = require("./services/menu-service");

const MENU_TOOL_FAILED = {
  error: "menu_unavailable",
  instruction: "Say you cannot check the menu right now and give the WhatsApp number from <contact>. Don't name any item or price.",
};

const MENU_TOOLS = [
  {
    name: "list_categories",
    description: "List the menu categories with their slugs and how many items each has.",
  },
  {
    name: "list_items",
    description: "List the items in one category, with item ids, names and prices. Use this rather than asking for the whole menu.",
    input_schema: {
      type: "object",
      properties: { category_slug: { type: "string", description: "The slug of one category from <categories>." } },
      required: ["category_slug"],
    },
  },
  {
    name: "search_items",
    description:
      "Search all menu items by name, with item ids, names and prices. If no item matches every word, closeMatches lists " +
      "real items matching some of the words, which are the alternatives to offer.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The words to look for, such as what the customer asked for." } },
      required: ["text"],
    },
  },
  {
    name: "get_item",
    description: "Get one menu item by its item id, including whether it is available right now.",
    input_schema: {
      type: "object",
      properties: { item_id: { type: "string", description: "An item id from an earlier menu tool result." } },
      required: ["item_id"],
    },
  },
  {
    name: "find_items_within_budget",
    description:
      "Only for budget questions, where the customer names the most they want to spend (never for a request to change an item's price): the available items and deals that cost no more than the " +
      "budget, cheapest first. The result repeats the budget as the server formats it, so you may say it back.",
    input_schema: {
      type: "object",
      properties: {
        max_rupees: { type: "integer", description: "The customer's budget in whole rupees, as they said it." },
        category_slug: { type: "string", description: "Optional: only this category from <categories>." },
      },
      required: ["max_rupees"],
    },
  },
  {
    name: "list_deals",
    description:
      "List the available deals with their ids, names and prices. contains lists exactly what comes in each deal. A deal is " +
      "fixed and sold at its own price, never the sum of its parts.",
  },
];

const MENU_TOOL_NAMES = MENU_TOOLS.map((tool) => tool.name);

function toToolItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description || "",
    pricePaisa: item.pricePaisa,
    priceDisplay: item.priceDisplay,
    available: item.isAvailable,
  };
}

async function listCategories() {
  const categories = await menuService.getMenu();
  return { categories: categories.map((category) => ({ slug: category.slug, name: category.name, itemCount: category.items.length })) };
}

async function listItems(categorySlug) {
  const categories = await menuService.getMenu();
  const category = categories.find((c) => c.slug === categorySlug);
  if (!category) return { found: false, categories: categories.map((c) => c.slug) };
  return { found: true, category: category.name, items: category.items.map(toToolItem) };
}

// Told about every search_items call that found nothing, for the dashboard's "asked for but not on
// the menu" list. Never awaited and never allowed to fail the search.
let searchMissLogger = null;
function setSearchMissLogger(logger) {
  searchMissLogger = logger;
}

function reportSearchMiss(text) {
  if (!searchMissLogger || typeof text !== "string" || !text.trim()) return;
  Promise.resolve()
    .then(() => searchMissLogger(text))
    .catch((error) => console.error("Search miss log failed:", error.code || error.message));
}

async function searchItems(text) {
  const items = await menuService.findItems(text);
  if (items.length > 0) return { found: true, items: items.map(toToolItem) };
  reportSearchMiss(text);

  const words = typeof text === "string" ? text.split(/\s+/).filter(Boolean) : [];
  const matches = new Map();
  for (const word of words) {
    for (const item of await menuService.findItems(word)) matches.set(item.id, item);
  }
  return { found: false, closeMatches: [...matches.values()].filter((item) => item.isAvailable).map(toToolItem) };
}

async function getItem(itemId) {
  const item = await menuService.getItemById(itemId);
  return item ? { found: true, item: toToolItem(item) } : { found: false };
}

async function listDeals() {
  const deals = await menuService.getDeals();
  return {
    deals: deals
      .filter((deal) => deal.isAvailable)
      .map((deal) => ({
        id: deal.id,
        name: deal.name,
        pricePaisa: deal.pricePaisa,
        priceDisplay: deal.priceDisplay,
        // Labels only: they already say how many ("5 Zinger Burgers"), and no part has a price to add up.
        contains: deal.items.map((dealItem) => dealItem.label),
      })),
  };
}

// Each category shows its cheapest few, so no category is ever left out; one category asked for
// by slug is shown in full. Whatever isn't shown is counted by the server, never by the model.
const BUDGET_ITEMS_PER_CATEGORY = 2;

function priceRange(items) {
  const prices = items.map((item) => item.pricePaisa);
  return { from: menuService.formatPrice(Math.min(...prices)), to: menuService.formatPrice(Math.max(...prices)) };
}

// The line the customer must see when the list is cut short. Written here, from the menu, so the
// count and both amounts come from a tool result and pass the price guard.
function budgetMoreLine(hidden, categories) {
  const { from, to } = priceRange(hidden);
  const between = from === to ? `at ${from}` : `between ${from} and ${to}`;
  const noun = hidden.length === 1 ? "item" : "items";
  return `...and ${hidden.length} more ${noun} ${between}. Would you like to see them by category (${categories.join(", ")})?`;
}

// Only whole rupees are taken in; the comparison is done in paisa on the menu's own prices.
async function findItemsWithinBudget(maxRupees, categorySlug) {
  if (!Number.isInteger(maxRupees) || maxRupees <= 0 || maxRupees > 1000000) {
    return { error: "max_rupees must be a whole number of rupees.", instruction: "Ask the customer for their budget." };
  }
  const maxPaisa = maxRupees * 100;
  const [categories, deals] = await Promise.all([menuService.getMenu(), menuService.getDeals()]);
  const chosen = categorySlug ? categories.filter((c) => c.slug === categorySlug) : categories;
  const groups = chosen.map((c) => ({
    category: c.name,
    slug: c.slug,
    items: c.items.filter((item) => item.isAvailable && item.pricePaisa <= maxPaisa).map(toToolItem),
  }));
  if (!categorySlug) {
    groups.push({
      category: "Deals",
      slug: "deals",
      items: deals
        .filter((deal) => deal.isAvailable && deal.pricePaisa <= maxPaisa)
        .map((deal) => ({ id: deal.id, name: deal.name, pricePaisa: deal.pricePaisa, priceDisplay: deal.priceDisplay, contains: deal.items.map((d) => d.label) })),
    });
  }
  const matching = groups.filter((g) => g.items.length > 0).map((g) => ({ ...g, items: [...g.items].sort((a, b) => a.pricePaisa - b.pricePaisa) }));
  const limit = categorySlug ? Infinity : BUDGET_ITEMS_PER_CATEGORY;
  const hidden = matching.flatMap((g) => g.items.slice(limit));
  const shown = matching.map((g) => ({
    category: g.category,
    slug: g.slug,
    items: g.items.slice(0, limit),
    ...(g.items.length > limit ? { moreInCategory: g.items.length - limit } : {}),
  }));
  const totalMatching = matching.reduce((sum, g) => sum + g.items.length, 0);
  const result = { budget: menuService.formatPrice(maxPaisa), found: totalMatching > 0, totalMatching, groups: shown };
  if (hidden.length === 0) {
    return {
      ...result,
      instruction: "Every matching item is listed. Show them by category, every item with its priceDisplay. Don't say there are more.",
    };
  }
  const moreCategories = shown.filter((g) => g.moreInCategory).map((g) => g.category);
  return {
    ...result,
    notShown: { count: hidden.length, ...priceRange(hidden), categories: moreCategories },
    moreLine: budgetMoreLine(hidden, moreCategories),
    instruction:
      "Show every item in groups, by category, with its priceDisplay; don't drop any. Then give moreLine: you may put it in " +
      "the customer's language, but keep its number and both amounts exactly. When you offer categories to see, name " +
      "only ones from notShown.categories (all of them, or say \"any of these categories\"), never any other. Never work out a count or a price range " +
      "yourself. If they pick a category, call find_items_within_budget again with its slug to list it in full.",
  };
}

// A failed read becomes a tool result the model must act on, so a Supabase outage never ends the chat.
async function runMenuTool(name, args) {
  const input = args || {};
  try {
    if (name === "list_categories") return await listCategories();
    if (name === "list_items") return await listItems(input.category_slug);
    if (name === "search_items") return await searchItems(input.text);
    if (name === "get_item") return await getItem(input.item_id);
    if (name === "list_deals") return await listDeals();
    if (name === "find_items_within_budget") return await findItemsWithinBudget(input.max_rupees, input.category_slug);
  } catch (error) {
    console.error(`Menu tool ${name} failed:`, error.code || error.message);
    return MENU_TOOL_FAILED;
  }
  return { error: `unknown menu tool ${name}` };
}

// The shape orders.js prices from. Available items and deals only, so anything else can't be ordered.
async function getOrderableMenu() {
  const [categories, deals] = await Promise.all([menuService.getMenu(), menuService.getDeals()]);
  const toOrderable = ({ id, name, pricePaisa }) => ({ id, name, pricePaisa });
  return {
    categories: [
      ...categories.map((category) => ({ name: category.name, slug: category.slug, items: category.items.map(toOrderable) })),
      {
        name: "Deals",
        slug: "deals",
        items: deals
          .filter((deal) => deal.isAvailable)
          .map((deal) => ({
            ...toOrderable(deal),
            contains: deal.items.map((dealItem) => dealItem.label),
            containsItemIds: deal.items.map((dealItem) => dealItem.itemId).filter(Boolean),
          })),
      },
    ],
  };
}

module.exports = { MENU_TOOLS, MENU_TOOL_NAMES, runMenuTool, getOrderableMenu, setSearchMissLogger };
