// The kitchen's WhatsApp pop-up: phone format, link, when it opens, the queue, the message built
// from the saved order, and the protected route. Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { waNumber, waLink, createWhatsAppOffers } = require("../admin/kitchen-whatsapp");
const { buildCustomerMessage, whatsappForOrder, DEFAULT_DELIVERY_ETA } = require("./whatsapp-message");
const { addKitchenRoutes } = require("./kitchen");
const { formatRupees } = require("./orders");

// Test data only: made-up names, numbers and items, nothing from the real menu.
const ID_A = "DB-20261110-AAAAAA";
const ID_B = "DB-20261110-BBBBBB";
const ID_C = "DB-20261110-CCCCCC";

function row(overrides = {}) {
  return {
    order_id: ID_A,
    status: "READY",
    order_type: "delivery",
    customer_name: "Test Customer",
    customer_phone: "0300 0000001",
    delivery_address: "House 1, Test Street",
    delivery_unit: "Flat 2",
    items: [
      { name: "Test Wrap", quantity: 2, unitPricePaisa: 12345, lineTotalPaisa: 24690, options: [{ name: "Sauce", choice: "Mild" }] },
      { name: "Test Drink", quantity: 1, unitPricePaisa: 5000, lineTotalPaisa: 5000, options: [] },
    ],
    total_paisa: 39690,
    delivery_fee_paisa: 10000,
    ...overrides,
  };
}

/* ---------- Phone numbers ---------- */

test("Pakistani mobile numbers in any common format become 92 3xxxxxxxxx", () => {
  for (const input of ["03001234567", "0300 1234567", "0300-1234567", "+92 300 1234567", "+923001234567",
    "00923001234567", "0092 300 123 4567", "923001234567", "3001234567", "(0300) 123-4567", " 0300.123.4567 "]) {
    assert.equal(waNumber(input), "923001234567", input);
  }
});

test("anything that isn't a usable mobile number gives null, never a broken link", () => {
  for (const input of ["", "12", "0421234567", "+44 7700 900123", "0300123456", "030012345678", "0300-12345a7",
    "92300123456", null, undefined, {}, "++923001234567"]) {
    assert.equal(waNumber(input), null, String(input));
  }
  assert.equal(waLink(null, "hi"), null);
  assert.equal(waLink("923001234567", ""), null);
  assert.equal(waLink("12345", "hi"), null);
});

test("the link is wa.me with the whole message URL-encoded, Urdu and symbols included", () => {
  const text = "Assalam o Alaikum سمر! Order #1 & 50% off?\nNew line + more";
  const link = waLink("923001234567", text);
  assert.ok(link.startsWith("https://wa.me/923001234567?text="));
  const encoded = link.split("?text=")[1];
  assert.equal(decodeURIComponent(encoded), text, "decodes back to exactly the message");
  assert.doesNotMatch(encoded, /[ &#?\n+سمر]/, "no raw spaces, &, #, ?, + or Urdu letters in the URL");
});

/* ---------- When the pop-up opens, and the queue ---------- */

test("only a tap that moves an order to READY opens the pop-up", () => {
  const offers = createWhatsAppOffers();
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "COMPLETED", source: "button" }), false, "not on COMPLETED");
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "PREPARING", source: "button" }), false);
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "CANCELLED", source: "button" }), false);
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "load" }), false, "not on page load or polling");
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY" }), false, "no source, no pop-up");
  assert.equal(offers.pending(), 0);
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "button" }), true);
  assert.equal(offers.next(), ID_A);
});

test("an order is offered once per page, even if moved back and to READY again", () => {
  const offers = createWhatsAppOffers();
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "button" }), true);
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "button" }), false);
  offers.next();
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "button" }), false);
  assert.equal(offers.next(), null);
});

test("an order already sent (remembered across a reload) is not offered again; Send again still works", () => {
  const offers = createWhatsAppOffers({ sent: [ID_A] });
  assert.equal(offers.isSent(ID_A), true);
  assert.equal(offers.onStatusMoved({ orderId: ID_A, to: "READY", source: "button" }), false);
  assert.equal(offers.offerAgain(ID_A), true);
  assert.equal(offers.offerAgain(ID_A), false, "not queued twice");
  assert.equal(offers.next(), ID_A);
});

test("several orders moved in a row queue up and come out one at a time, in order", () => {
  const offers = createWhatsAppOffers();
  for (const id of [ID_A, ID_B, ID_C]) offers.onStatusMoved({ orderId: id, to: "READY", source: "button" });
  assert.equal(offers.pending(), 3);
  assert.deepEqual([offers.next(), offers.next(), offers.next(), offers.next()], [ID_A, ID_B, ID_C, null]);
});

test("markSent records the order for the card badge", () => {
  const offers = createWhatsAppOffers();
  assert.equal(offers.isSent(ID_B), false);
  offers.markSent(ID_B);
  assert.equal(offers.isSent(ID_B), true);
  assert.deepEqual(offers.sentIds(), [ID_B]);
});

/* ---------- The message, from the saved order row ---------- */

test("delivery message: greeting, order number, ETA, items, total with the fee, address", () => {
  const text = buildCustomerMessage(row(), null);
  const lines = text.split("\n");
  assert.equal(lines[0], `Assalam o Alaikum Test Customer! Your Doner Bros order ${ID_A} is on its way. The rider is coming to you and you will get your order in 30 to 45 minutes.`);
  assert.ok(lines.includes("Order details:"));
  assert.ok(lines.includes(`- 2 x Test Wrap (Mild): ${formatRupees(24690)}`));
  assert.ok(lines.includes(`- 1 x Test Drink: ${formatRupees(5000)}`));
  assert.ok(lines.includes(`Total: ${formatRupees(39690)} (includes delivery fee: ${formatRupees(10000)})`));
  assert.ok(lines.includes("Delivery address: House 1, Test Street, Flat 2"));
  assert.equal(lines[lines.length - 1], "Thank you for choosing Doner Bros!");
  assert.deepEqual(DEFAULT_DELIVERY_ETA, { minMinutes: 30, maxMinutes: 45 });
});

test("the ETA comes from settings when they're set", () => {
  assert.match(buildCustomerMessage(row(), { minMinutes: 20, maxMinutes: 25 }), /in 20 to 25 minutes\./);
});

test("delivery fee not decided: no fee amount, 'to be confirmed' instead; free delivery says so", () => {
  const tbc = buildCustomerMessage(row({ delivery_fee_paisa: null, total_paisa: 29690 }), null);
  assert.ok(tbc.includes(`Total: ${formatRupees(29690)}, delivery fee to be confirmed`));
  assert.doesNotMatch(tbc, /includes delivery fee/);
  const free = buildCustomerMessage(row({ delivery_fee_paisa: 0, total_paisa: 29690 }), null);
  assert.ok(free.includes(`Total: ${formatRupees(29690)} (free delivery)`));
});

test("pickup message: ready for pickup, items and total, no address or delivery fee", () => {
  const text = buildCustomerMessage(row({ order_type: "pickup", delivery_address: null, delivery_unit: null, delivery_fee_paisa: null, total_paisa: 29690 }), null);
  const lines = text.split("\n");
  assert.equal(lines[0], `Assalam o Alaikum Test Customer! Your Doner Bros order ${ID_A} is ready for pickup.`);
  assert.ok(lines.includes(`Total: ${formatRupees(29690)}`));
  assert.equal(lines[lines.length - 1], "Thank you!");
  assert.doesNotMatch(text, /delivery|address|rider/i);
});

test("amounts are the saved ones, never recalculated (a mismatched total is shown as saved)", () => {
  const text = buildCustomerMessage(row({ total_paisa: 12300 }), null);
  assert.ok(text.includes(`Total: ${formatRupees(12300)} (includes`), "the row's total_paisa, not a sum of the lines");
});

test("no name: a plain greeting; Urdu names survive into the link", () => {
  assert.match(buildCustomerMessage(row({ customer_name: "  " }), null), /^Assalam o Alaikum! Your/);
  const info = whatsappForOrder(row({ customer_name: "سمر" }), null);
  assert.equal(info.waNumber, "923000000001");
  assert.ok(decodeURIComponent(waLink(info.waNumber, info.text).split("?text=")[1]).includes("Assalam o Alaikum سمر!"));
});

test("an order with no valid phone gets no number, so the pop-up shows a message instead of a link", () => {
  for (const phone of [null, "", "12345"]) {
    const info = whatsappForOrder(row({ customer_phone: phone }), null);
    assert.equal(info.waNumber, null);
    assert.equal(waLink(info.waNumber, info.text), null);
  }
});

/* ---------- The route ---------- */

function fakeClient(rows, calls = []) {
  return {
    from(table) {
      const q = { table, filters: {} };
      const chain = {
        select(cols) { q.cols = cols; return chain; },
        eq(col, value) { q.filters[col] = value; return chain; },
        async maybeSingle() {
          calls.push(q);
          return { data: rows.find((r) => r.order_id === q.filters.order_id) || null, error: null };
        },
      };
      return chain;
    },
  };
}

async function startApp(rows, { signedIn = true, calls = [] } = {}) {
  const app = express();
  const requireKitchen = (req, res, next) => (signedIn ? next() : res.status(401).json({ error: "Log in." }));
  addKitchenRoutes(app, { client: fakeClient(rows, calls), requireKitchen, requireDatabase: (req, res, next) => next(),
    adminDir: path.join(__dirname, "..", "admin"), getDeliveryEta: async () => null });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("the message route returns that one order's message, built on the server", async () => {
  const calls = [];
  const other = row({ order_id: ID_B, customer_name: "Other Person", total_paisa: 99900 });
  const { base, close } = await startApp([row(), other], { calls });
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const res = await fetch(`${base}/api/admin/orders/${ID_A}/whatsapp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.orderId, ID_A);
    assert.equal(body.waNumber, "923000000001");
    assert.equal(body.text, buildCustomerMessage(row(), null));
    assert.doesNotMatch(body.text, /Other Person|999/, "never another order's data");
    assert.equal(calls[0].table, "orders");
    assert.equal(calls[0].filters.order_id, ID_A);
    assert.ok(!logs.some((l) => l.includes("0300") || l.includes("923000000001")), "the phone number is never logged");
  } finally {
    console.log = original;
    close();
  }
});

test("the message route is protected, checks the id, and only answers for READY or COMPLETED orders", async () => {
  const signedOut = await startApp([row()], { signedIn: false });
  try {
    assert.equal((await fetch(`${signedOut.base}/api/admin/orders/${ID_A}/whatsapp`)).status, 401);
    assert.equal((await fetch(`${signedOut.base}/admin/kitchen-whatsapp.js`)).status, 401);
  } finally { signedOut.close(); }

  const { base, close } = await startApp([row(), row({ order_id: ID_B, status: "PREPARING" })]);
  try {
    assert.equal((await fetch(`${base}/api/admin/orders/not-an-id/whatsapp`)).status, 400);
    assert.equal((await fetch(`${base}/api/admin/orders/${ID_C}/whatsapp`)).status, 404);
    assert.equal((await fetch(`${base}/api/admin/orders/${ID_B}/whatsapp`)).status, 409);
    assert.equal((await fetch(`${base}/admin/kitchen-whatsapp.js`)).status, 200);
  } finally { close(); }
});

/* ---------- The board wires it up the tested way ---------- */

test("the board opens the pop-up only from the status button, never on load or on COMPLETED", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "kitchen.html"), "utf8");
  assert.match(html, /<script src="\/admin\/kitchen-whatsapp\.js"><\/script>/);
  assert.match(html, /offers\.onStatusMoved\(\{ orderId: id, to, source: "button" \}\)/, "the tap in move() is the trigger");
  assert.equal((html.match(/onStatusMoved\(/g) || []).length, 1, "nothing else triggers it");
  assert.doesNotMatch(html, /to === "COMPLETED"/, "the old COMPLETED trigger is gone");
  const load = html.slice(html.indexOf("async function load()"), html.indexOf("function noticeNew"));
  assert.doesNotMatch(load, /showNextWa|onStatusMoved|offerAgain/, "loading the board never opens it");
  assert.match(html, /Send WhatsApp to customer/);
  assert.match(html, /No valid phone number for this customer/);
  assert.match(html, /WhatsApp sent ✓/);
  assert.match(html, /id="wa-send" href="#" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /console\.(log|info|warn|error)\([^)]*(phone|waNumber)/i, "the board never logs the phone");
});
