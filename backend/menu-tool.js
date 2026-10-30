// Doner Bros — the getMenu tool Gemini can call. It reads data/menu.json on every call, so the
// answer matches the file, and returns only items customers can order right now.

const fs = require("fs");
const path = require("path");

const MENU_PATH = path.join(__dirname, "..", "data", "menu.json");
const MENU_NOT_AVAILABLE = {
  error: "The menu couldn't be loaded right now. Don't list any items; ask the customer to call the restaurant.",
};

// No parameters: the tool always returns the whole orderable menu.
const GET_MENU_TOOL = {
  name: "getMenu",
  description:
    "Get the current Doner Bros menu: every item that can be ordered now, with its id, name, description, price and options. " +
    "Call this when the customer asks what's on the menu, or about items, prices or options.",
};

function formatRupees(paisa) {
  return `Rs ${(paisa / 100).toLocaleString("en-PK")}`;
}

function isValidPaisa(value) {
  return Number.isInteger(value) && value >= 0;
}

function toToolOption(option) {
  if (!option || typeof option.name !== "string" || !Array.isArray(option.choices)) return null;

  const choices = [];
  for (const choice of option.choices) {
    if (typeof choice === "string") {
      choices.push({ name: choice });
    } else if (choice && typeof choice.name === "string" && isValidPaisa(choice.pricePaisa)) {
      choices.push({ name: choice.name, extraPrice: formatRupees(choice.pricePaisa) });
    } else {
      return null;
    }
  }
  return { name: option.name, required: option.required === true, choices };
}

// A broken item is left out entirely rather than shown with missing prices or options.
function toToolItem(item) {
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !isValidPaisa(item.pricePaisa)) return null;
  if (item.availability === "unavailable") return null;
  if (item.options !== undefined && !Array.isArray(item.options)) return null;

  const options = [];
  for (const option of item.options || []) {
    const toolOption = toToolOption(option);
    if (!toolOption) return null;
    options.push(toolOption);
  }

  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    price: formatRupees(item.pricePaisa),
    options,
  };
}

function menuForTool(menu) {
  if (!menu || !Array.isArray(menu.categories)) return MENU_NOT_AVAILABLE;

  const categories = menu.categories
    .map((category) => ({
      name: category && typeof category.name === "string" ? category.name : "Other",
      items: (category && Array.isArray(category.items) ? category.items : []).map(toToolItem).filter(Boolean),
    }))
    .filter((category) => category.items.length > 0);

  if (categories.length === 0) return MENU_NOT_AVAILABLE;
  return { currency: "PKR", categories };
}

function getMenu(menuPath = MENU_PATH) {
  let menu;
  try {
    menu = JSON.parse(fs.readFileSync(menuPath, "utf8"));
  } catch (error) {
    console.error("getMenu: menu.json could not be read:", error.code || error.name);
    return MENU_NOT_AVAILABLE;
  }
  return menuForTool(menu);
}

module.exports = { GET_MENU_TOOL, getMenu, menuForTool };
