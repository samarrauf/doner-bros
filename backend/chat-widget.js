// What the chat widget shows before the customer types: quick-reply chips and the input placeholder.
// Everything is built from the menu service's live data; no item, category or price is written here.

const { formatPrice } = require("./services/menu-service");

// The one place the "Under Rs ..." chip's limit is set, in paisa.
const UNDER_PRICE_LIMIT_PAISA = 50000;

// The menu_settings key listing which categories get a chip (see supabase/migrations/0006).
const QUICK_CATEGORIES_SETTING = "chat_quick_categories";

// Emoji only: picked by words in a category's own name, with a plain plate when nothing matches.
const CATEGORY_EMOJI = [
  [/pasta/i, "🍝"],
  [/shawarma|wrap|roll/i, "🌯"],
  [/burger/i, "🍔"],
  [/drink|beverage|juice|shake/i, "🥤"],
  [/fries|chips/i, "🍟"],
  [/nugget|wing/i, "🍗"],
  [/paratha/i, "🫓"],
  [/kebab|doner/i, "🥙"],
  [/platter|box/i, "🍱"],
  [/special/i, "⭐"],
];

function categoryEmoji(name) {
  const match = CATEGORY_EMOJI.find(([pattern]) => pattern.test(name));
  return match ? match[1] : "🍽️";
}

// The setting's slugs, in order. null when it's missing or empty: every category then gets a chip.
function parseQuickCategories(value) {
  const slugs = String(value || "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  return slugs.length ? slugs : null;
}

function chip(emoji, label, message) {
  return { emoji, label, message };
}

// menu is the public menu ({ categories, deals }); quickCategories is the setting's raw value.
function buildQuickReplies(menu, quickCategories) {
  const withItems = menu.categories.filter((category) => category.items.length > 0 && category.slug !== "deals");
  const chosen = parseQuickCategories(quickCategories);
  const categories = chosen
    ? chosen.map((slug) => withItems.find((category) => category.slug === slug)).filter(Boolean)
    : withItems;

  const chips = [chip("🍽️", "Browse menu", "Show me the menu")];
  if (menu.deals.length > 0) chips.push(chip("🎁", "Deals", "What deals do you have?"));
  for (const category of categories) {
    chips.push(chip(categoryEmoji(category.name), category.name, `Show me your ${category.name}`));
  }
  const limit = formatPrice(UNDER_PRICE_LIMIT_PAISA);
  chips.push(chip("💸", `Under ${limit}`, `What can I get for under ${limit}?`));
  return chips;
}

// "e.g. Two {item} and a {drink}", from a random available item and drink on the live menu.
function buildPlaceholder(menu, random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const isDrinks = (category) => /drink|beverage/i.test(`${category.slug} ${category.name}`);
  const food = menu.categories.filter((category) => !isDrinks(category)).flatMap((category) => category.items);
  const drinks = menu.categories.filter(isDrinks).flatMap((category) => category.items);
  if (food.length === 0) return "Type your message...";
  const item = pick(food).name;
  return drinks.length > 0 ? `e.g. Two ${item} and a ${pick(drinks).name}` : `e.g. Two ${item}`;
}

module.exports = { UNDER_PRICE_LIMIT_PAISA, QUICK_CATEGORIES_SETTING, buildQuickReplies, buildPlaceholder, categoryEmoji };
