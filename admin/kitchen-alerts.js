// Doner Bros kitchen board: when to ring, and when to remind. No sound or DOM code here, so the same
// file runs in the board (window.KitchenAlerts) and in the backend tests (require).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KitchenAlerts = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Every timing the board's alerts use, in one place.
  const CONFIG = Object.freeze({
    RING_MS: 3000,                     // new-order ringtone length
    FLASH_MS: 6000,                    // how long a new card flashes
    REMINDER_AFTER_MS: 2 * 60 * 1000,  // an order this long in New starts the reminder ping
    REMINDER_EVERY_MS: 60 * 1000,      // and it pings again this often until the order is moved
    PING_MS: 1000,                     // reminder ping length
  });

  // Tells which orders are new to this board. The first list it is given only teaches it what is
  // already there (no ring on page load). After that, each order id is reported once per page, so a
  // status change, or an order moved back to New, never rings again.
  function createNewOrderDetector() {
    let seen = null;
    return {
      check(orders) {
        const ids = (orders || []).map((o) => o.orderId);
        if (seen === null) {
          seen = new Set(ids);
          return [];
        }
        const fresh = [];
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          fresh.push(id);
        }
        return fresh;
      },
    };
  }

  // A reminder ping is due when any order has waited in New for REMINDER_AFTER_MS and the last ping
  // (null if none yet) was at least REMINDER_EVERY_MS ago. All times in milliseconds, same clock.
  function reminderDue(orders, nowMs, lastPingMs, config = CONFIG) {
    const waiting = (orders || []).some((o) => o.status === "NEW"
      && nowMs - Date.parse(o.statusChangedAt || o.createdAt) >= config.REMINDER_AFTER_MS);
    if (!waiting) return false;
    return lastPingMs === null || lastPingMs === undefined || nowMs - lastPingMs >= config.REMINDER_EVERY_MS;
  }

  return { CONFIG, createNewOrderDetector, reminderDue };
});
