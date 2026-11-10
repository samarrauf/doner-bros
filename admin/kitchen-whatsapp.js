// Doner Bros kitchen board: the WhatsApp pop-up's rules. No DOM code here, so the same file runs in
// the board (window.KitchenWhatsApp), on the server (require) and in the tests.
//
// Click-to-chat only: this builds a wa.me link that staff open themselves. Nothing is ever sent
// automatically, and the phone number is never logged.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KitchenWhatsApp = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // A Pakistani mobile number as wa.me wants it: 92 followed by 3 and nine more digits.
  // Accepts 03xx..., 3xx..., +92..., 0092..., 92..., with spaces, dashes, dots or brackets.
  // Anything else (landlines, foreign or short numbers) comes back null.
  function waNumber(phone) {
    if (typeof phone !== "string" && typeof phone !== "number") return null;
    let d = String(phone).replace(/[\s\-().]/g, "");
    if (d.startsWith("+")) d = d.slice(1);
    if (!/^\d+$/.test(d)) return null;
    if (d.startsWith("0092")) d = d.slice(2);
    if (/^03\d{9}$/.test(d)) d = `92${d.slice(1)}`;
    else if (/^3\d{9}$/.test(d)) d = `92${d}`;
    return /^923\d{9}$/.test(d) ? d : null;
  }

  // The click-to-chat link, or null when there's no usable number or no text.
  function waLink(number, text) {
    if (!/^923\d{9}$/.test(String(number || "")) || typeof text !== "string" || !text) return null;
    return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  }

  // Decides when the pop-up opens and keeps the pop-ups in a queue, one at a time.
  // - Only a move to READY made by a staff tap on the status button opens one (source "button");
  //   loading the board, polling and any other status never do.
  // - Each order is offered at most once per page; "Send again" on the card (offerAgain) is the
  //   only way to see it again.
  // - sent holds order ids whose message staff opened, so the card can show "WhatsApp sent ✓".
  function createWhatsAppOffers({ sent = [] } = {}) {
    const offered = new Set();
    const sentIds = new Set(sent);
    const queue = [];
    return {
      onStatusMoved({ orderId, to, source }) {
        if (source !== "button" || to !== "READY" || !orderId) return false;
        if (offered.has(orderId) || sentIds.has(orderId)) return false;
        offered.add(orderId);
        queue.push(orderId);
        return true;
      },
      offerAgain(orderId) {
        if (!orderId || queue.includes(orderId)) return false;
        offered.add(orderId);
        queue.push(orderId);
        return true;
      },
      next() { return queue.shift() || null; },
      pending() { return queue.length; },
      markSent(orderId) { if (orderId) sentIds.add(orderId); },
      isSent(orderId) { return sentIds.has(orderId); },
      sentIds() { return [...sentIds]; },
    };
  }

  return { waNumber, waLink, createWhatsAppOffers };
});
