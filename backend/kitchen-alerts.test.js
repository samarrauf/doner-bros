// The kitchen board's alert rules (admin/kitchen-alerts.js): when a new order rings, and when an
// order waiting in New gets a reminder ping.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONFIG, createNewOrderDetector, reminderDue, startScreenNeeded } = require("../admin/kitchen-alerts");

const order = (orderId, status = "NEW", at = "2026-11-10T10:00:00Z") => ({ orderId, status, createdAt: at, statusChangedAt: at });
const ID_A = "DB-20261110-AAAAAA";
const ID_B = "DB-20261110-BBBBBB";
const ID_C = "DB-20261110-CCCCCC";

test("the first load never rings, even with orders already on the board", () => {
  const detector = createNewOrderDetector();
  assert.deepEqual(detector.check([order(ID_A), order(ID_B)]), []);
});

test("an empty first load still counts as the first load", () => {
  const detector = createNewOrderDetector();
  assert.deepEqual(detector.check([]), []);
  assert.deepEqual(detector.check([order(ID_A)]), [ID_A], "the next order to arrive rings");
});

test("a new order id rings once, and only once", () => {
  const detector = createNewOrderDetector();
  detector.check([order(ID_A)]);
  assert.deepEqual(detector.check([order(ID_A), order(ID_B)]), [ID_B]);
  assert.deepEqual(detector.check([order(ID_A), order(ID_B)]), [], "the next poll does not ring again");
});

test("a status change is not a new order", () => {
  const detector = createNewOrderDetector();
  detector.check([order(ID_A, "NEW")]);
  assert.deepEqual(detector.check([order(ID_A, "PREPARING")]), []);
  assert.deepEqual(detector.check([order(ID_A, "READY")]), []);
  assert.deepEqual(detector.check([order(ID_A, "NEW")]), [], "moved back to New: still no ring");
});

test("an order that leaves the board and comes back does not ring twice", () => {
  const detector = createNewOrderDetector();
  detector.check([]);
  assert.deepEqual(detector.check([order(ID_A)]), [ID_A]);
  assert.deepEqual(detector.check([]), []);
  assert.deepEqual(detector.check([order(ID_A)]), []);
});

test("several new orders in one poll are each reported once", () => {
  const detector = createNewOrderDetector();
  detector.check([order(ID_A)]);
  assert.deepEqual(detector.check([order(ID_A), order(ID_B), order(ID_C), order(ID_B)]), [ID_B, ID_C]);
});

test("the reminder waits until an order has been in New for the configured time", () => {
  const start = Date.parse("2026-11-10T10:00:00Z");
  const orders = [order(ID_A, "NEW", "2026-11-10T10:00:00Z")];
  assert.equal(reminderDue(orders, start + CONFIG.REMINDER_AFTER_MS - 1, null), false);
  assert.equal(reminderDue(orders, start + CONFIG.REMINDER_AFTER_MS, null), true);
});

test("the reminder repeats at the configured interval, not more often", () => {
  const start = Date.parse("2026-11-10T10:00:00Z");
  const orders = [order(ID_A, "NEW", "2026-11-10T10:00:00Z")];
  const firstPing = start + CONFIG.REMINDER_AFTER_MS;
  assert.equal(reminderDue(orders, firstPing + CONFIG.REMINDER_EVERY_MS - 1, firstPing), false);
  assert.equal(reminderDue(orders, firstPing + CONFIG.REMINDER_EVERY_MS, firstPing), true);
});

test("the reminder stops once the order is moved out of New", () => {
  const start = Date.parse("2026-11-10T10:00:00Z");
  const later = start + CONFIG.REMINDER_AFTER_MS * 3;
  assert.equal(reminderDue([order(ID_A, "PREPARING", "2026-11-10T10:00:00Z")], later, null), false);
  assert.equal(reminderDue([], later, null), false);
});

test("the timings live in one config object and can't be changed by accident", () => {
  assert.ok(Object.isFrozen(CONFIG));
  assert.ok(CONFIG.RING_MS >= 2500 && CONFIG.RING_MS <= 3500, "ring lasts about 3 seconds");
  assert.equal(CONFIG.REMINDER_AFTER_MS, 2 * 60 * 1000);
});

test("the START screen shows while sound is wanted but the browser blocks it", () => {
  for (const audioState of ["none", "suspended", "interrupted", "closed"]) {
    assert.equal(startScreenNeeded({ audioState, muted: false }), true, audioState);
  }
});

test("the START screen goes away once sound is allowed, or if staff turned sound off", () => {
  assert.equal(startScreenNeeded({ audioState: "running", muted: false }), false);
  assert.equal(startScreenNeeded({ audioState: "suspended", muted: true }), false);
});

test("the board has a START screen and no 'sound blocked' bar", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "kitchen.html"), "utf8");
  assert.match(html, /id="start-btn"/);
  assert.match(html, /Start kitchen/);
  assert.doesNotMatch(html, /id="sound-notice"/);
  assert.match(html, /startScreenNeeded/, "the board uses the tested rule");
});

test("a rejected login covers the board with 'Session ended' instead of stopping silently", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "kitchen.html"), "utf8");
  assert.match(html, /id="ended"[^>]*role="alertdialog"/);
  assert.match(html, /Session ended - log in again/);
  assert.match(html, /id="ended-btn" href="\/kitchen\/login\?next=%2Fadmin%2Fkitchen"/);
  assert.match(html, /res\.status === 401\) \{\s*sessionEnded\(\);/, "a 401 shows the screen");
  assert.doesNotMatch(html, /location\.assign\(`\/kitchen\/login/, "the board never navigates away by itself");
  assert.match(html, /if \(loading \|\| state\.ended\) return;/, "polling stops once ended");
  assert.match(html, /TAB_KEY = "kitchen\.tab"/, "the chosen column is remembered");
});
