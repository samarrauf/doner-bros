// What the chat widget shows before the customer types: quick-reply chips and the input placeholder.
// Everything is built from the menu service's live data; no item, category or price is written here.

const { formatPrice } = require("./services/menu-service");

// The one place the "Under Rs ..." chip's limit is set, in paisa.
const UNDER_PRICE_LIMIT_PAISA = 50000;

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

// Items flagged as featured or popular, if the menu has such a flag. It has none today.
function popularItems(categories) {
  return categories.flatMap((category) => category.items).filter((item) => item.isFeatured === true || item.isPopular === true);
}

function chip(emoji, label, message) {
  return { emoji, label, message };
}

// menu is the public menu ({ categories, deals, settings }); hours is the server's opening-hours list.
function buildQuickReplies(menu, hours) {
  const categories = menu.categories.filter((category) => category.items.length > 0 && category.slug !== "deals");
  const chips = [chip("📋", "Browse menu", "Show me the menu")];
  if (menu.deals.length > 0) chips.push(chip("🎁", "Deals", "What deals do you have?"));
  if (popularItems(menu.categories).length > 0) chips.push(chip("🔥", "Popular", "What are your most popular items?"));
  for (const category of categories) {
    chips.push(chip(categoryEmoji(category.name), category.name, `Show me your ${category.name}`));
  }
  const limit = formatPrice(UNDER_PRICE_LIMIT_PAISA);
  chips.push(chip("💸", `Under ${limit}`, `What can I get for under ${limit}?`));
  chips.push({ ...chip("🛒", "My cart", null), action: "cart" });
  const address = menu.settings && menu.settings.address;
  if (address && Array.isArray(hours) && hours.length > 0) {
    chips.push(chip("📍", "Location & timings", "Where are you located and what are your timings?"));
  }
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

module.exports = { UNDER_PRICE_LIMIT_PAISA, buildQuickReplies, buildPlaceholder, categoryEmoji };
