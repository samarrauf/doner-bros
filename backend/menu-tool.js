// Doner Bros — the menu tools Gemini can call. Every lookup goes through the menu service, which
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
    parametersJsonSchema: {
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
    parametersJsonSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The words to look for, such as what the customer asked for." } },
      required: ["text"],
    },
  },
  {
    name: "get_item",
    description: "Get one menu item by its item id, including whether it is available right now.",
    parametersJsonSchema: {
      type: "object",
      properties: { item_id: { type: "string", description: "An item id from an earlier menu tool result." } },
      required: ["item_id"],
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

async function searchItems(text) {
  const items = await menuService.findItems(text);
  if (items.length > 0) return { found: true, items: items.map(toToolItem) };

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

// A failed read becomes a tool result the model must act on, so a Supabase outage never ends the chat.
async function runMenuTool(name, args) {
  const input = args || {};
  try {
    if (name === "list_categories") return await listCategories();
    if (name === "list_items") return await listItems(input.category_slug);
    if (name === "search_items") return await searchItems(input.text);
    if (name === "get_item") return await getItem(input.item_id);
    if (name === "list_deals") return await listDeals();
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

module.exports = { MENU_TOOLS, MENU_TOOL_NAMES, runMenuTool, getOrderableMenu };
