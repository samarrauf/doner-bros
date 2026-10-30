// Tests for the getMenu tool. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getMenu, menuForTool } = require("./menu-tool");

function writeTempMenu(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "menu-tool-")), "menu.json");
  fs.writeFileSync(file, text);
  return file;
}

test("returns every orderable item from data/menu.json with prices and options", () => {
  const result = getMenu();
  const items = result.categories.flatMap((category) => category.items);
  assert.equal(items.length, 13);

  const plate = items.find((item) => item.id === "mixed-doner-plate");
  assert.equal(plate.name, "Mixed Doner Plate");
  assert.equal(plate.price, "Rs 1,450");
  assert.deepEqual(plate.options, [{ name: "Base", required: true, choices: [{ name: "Rice" }, { name: "Chips" }] }]);

  const chips = items.find((item) => item.id === "seasoned-chips");
  assert.deepEqual(chips.options[0].choices, [{ name: "Add cheese", extraPrice: "Rs 100" }]);
});

test("leaves out unavailable and broken items", () => {
  const result = menuForTool({
    categories: [
      {
        name: "Doners",
        items: [
          { id: "a", name: "Available", description: "ok", pricePaisa: 50000, availability: "unknown" },
          { id: "b", name: "Sold out", description: "", pricePaisa: 50000, availability: "unavailable" },
          { id: "c", name: "No price", description: "" },
          { id: "d", name: "Bad option", pricePaisa: 100, options: [{ name: "Meat", choices: [{ name: "x" }] }] },
        ],
      },
      { name: "Empty", items: [{ id: "e", name: "Float price", pricePaisa: 9.5 }] },
    ],
  });
  assert.deepEqual(result, {
    currency: "PKR",
    categories: [{ name: "Doners", items: [{ id: "a", name: "Available", description: "ok", price: "Rs 500", options: [] }] }],
  });
});

test("a missing, invalid or empty menu returns an error instead of items", () => {
  assert.ok(getMenu(path.join(os.tmpdir(), "no-such-dir", "menu.json")).error);
  assert.ok(getMenu(writeTempMenu("{ not json")).error);
  assert.ok(getMenu(writeTempMenu('{"categories": "nope"}')).error);
  assert.ok(menuForTool({ categories: [{ name: "Doners", items: [] }] }).error);
  assert.ok(menuForTool(null).error);
});
