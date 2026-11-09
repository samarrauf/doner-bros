// Doner Bros — checks a model reply before it reaches the customer: every rupee amount in it must
// have come from a tool result in the same turn. Amounts are compared as whole paisa.

const NUMBER = String.raw`(\d[\d,]*(?:\.\d{1,2})?)`;
// (?![a-z]) rather than \b, so "Rs290" with no space is still read as an amount.
const CURRENCY = String.raw`(?:\b(?:rs|pkr|rupees?|rupay[a-z]*)(?![a-z])\.?|₨)`;
const BEFORE_NUMBER = new RegExp(`${CURRENCY}\\s*:?\\s*${NUMBER}`, "gi");
const AFTER_NUMBER = new RegExp(`${NUMBER}\\s*(?:${CURRENCY}|\\/-)`, "gi");

// Whole-number arithmetic only: "1,450" -> 145000, "290.5" -> 29050.
function toPaisa(amount) {
  const [rupees, fraction = ""] = amount.replace(/,/g, "").split(".");
  return Number(rupees) * 100 + Number(fraction.padEnd(2, "0") || 0);
}

// "Rs" amounts are taken out first, so in "Deal 2 Rs 500" the 2 isn't read as "2 Rs".
function rupeeAmounts(text) {
  const amounts = [];
  const rest = String(text || "").replace(BEFORE_NUMBER, (_, amount) => {
    amounts.push(toPaisa(amount));
    return " ";
  });
  for (const match of rest.matchAll(AFTER_NUMBER)) amounts.push(toPaisa(match[1]));
  return amounts;
}

function collectAmounts(value, key, found) {
  if (typeof value === "string") rupeeAmounts(value).forEach((paisa) => found.add(paisa));
  else if (Number.isInteger(value) && /paisa$/i.test(key || "")) found.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectAmounts(entry, key, found));
  else if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, child]) => collectAmounts(child, childKey, found));
  }
  return found;
}

// The amounts in the reply, as paisa, that no tool result in this turn contains.
function findUnbackedPrices(reply, toolResults) {
  const allowed = collectAmounts(toolResults, "", new Set());
  return [...new Set(rupeeAmounts(reply))].filter((paisa) => !allowed.has(paisa));
}

module.exports = { rupeeAmounts, findUnbackedPrices };
