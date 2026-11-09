// Doner Bros AI Order Assistant: the chat panel, quick-reply chips and cart drawer.
// Chips, the placeholder and the address come from /api/chat/config, and the cart (every amount
// in it) from /api/cart, all worked out by the server from the live menu. Nothing here names an
// item or a price. contactPhone comes from app.js, which loads first.

const CHAT_ENDPOINT = "/api/chat";
const CHAT_CONFIG_ENDPOINT = "/api/chat/config";
const CART_ENDPOINT = "/api/cart";
const CART_LINE_ENDPOINT = "/api/cart/line";
const CHECKOUT_MESSAGE = "I'd like to checkout my cart.";

function chatFallbackError() {
  return `Sorry, I couldn't reach the Doner Bros AI Order Assistant. Please try again, or call us on ${contactPhone.display}.`;
}

function newClickId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // randomUUID only exists on https and localhost.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The server's own account of the cart, shown after every Order click.
function describeCartForCustomer(cart) {
  if (cart.lines.length === 0) {
    return "Your cart is empty.";
  }
  const lines = cart.lines.flatMap((line) => [
    `${line.quantity} x ${line.name}${line.lineTotal ? `: ${line.lineTotal}` : ""}${line.orderable ? "" : " (can't be ordered right now)"}`,
    ...line.contains.map((label) => `    ${label}`),
  ]);
  return ["Your cart:", ...lines, ...(cart.total ? [`Total: ${cart.total}`] : [])].join("\n");
}

// Sends the message and prior turns to the backend; resolves with the response body.
// orderItem is set when a menu Order button sent the message: the server orders by its id, not the words.
async function requestOrderTakerReply(message, conversationHistory, orderItem) {
  let response;
  try {
    response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationHistory, orderItem }),
    });
  } catch (error) {
    // Network failure (offline, server down).
    throw new Error(chatFallbackError());
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.reply !== "string") {
    throw new Error(data.error || chatFallbackError());
  }
  return data;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong. Please try again.");
  }
  return data;
}

function chatElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function setupChatWidget() {
  const toggle = document.getElementById("chat-toggle");
  const panel = document.getElementById("chat-window");
  const closeButton = document.getElementById("chat-close");
  const subtitle = document.getElementById("chat-subtitle");
  const messages = document.getElementById("chat-messages");
  const chips = document.getElementById("chat-chips");
  const quickBar = document.getElementById("chat-quick");
  const quickToggle = document.getElementById("chat-quick-toggle");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const sendButton = document.getElementById("chat-send");
  const cartButton = document.getElementById("chat-cart");
  const cartCount = document.getElementById("chat-cart-count");
  const drawer = document.getElementById("chat-drawer");
  const drawerBody = document.getElementById("chat-drawer-body");
  const drawerFoot = document.getElementById("chat-drawer-foot");
  const drawerClose = document.getElementById("chat-drawer-close");
  const cartTotal = document.getElementById("chat-cart-total");
  const checkoutButton = document.getElementById("chat-checkout");

  /* ----- Open and close ----- */

  function setOpen(isOpen) {
    panel.hidden = !isOpen;
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close chat" : "Open chat");
    document.documentElement.classList.toggle("cw-open", isOpen);
    fitSheet();
    if (isOpen) {
      fitAddress();
      input.focus();
      refreshCart();
    } else {
      setDrawerOpen(false);
    }
  }

  function closeAndReturnFocus() {
    setOpen(false);
    toggle.focus();
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  closeButton.addEventListener("click", closeAndReturnFocus);

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (!drawer.hidden) {
      setDrawerOpen(false);
      cartButton.focus();
    } else {
      closeAndReturnFocus();
    }
  });

  /* ----- Messages ----- */

  function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addBubble(text, sender) {
    const bubble = chatElement("div", `cw-bubble cw-bubble-${sender}`, text);
    // Urdu script reads right to left; Roman Urdu and English left to right.
    bubble.dir = "auto";
    messages.appendChild(bubble);
    scrollToLatest();
    return bubble;
  }

  function showTyping() {
    const typing = chatElement("div", "cw-bubble cw-bubble-bot cw-typing");
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-label", "The assistant is typing");
    typing.append(chatElement("span"), chatElement("span"), chatElement("span"));
    messages.appendChild(typing);
    scrollToLatest();
    return typing;
  }

  /* ----- Quick-reply chips ----- */

  let chipsCollapsed = false;

  function renderChips(quickReplies) {
    chips.replaceChildren();
    quickReplies.forEach((reply) => {
      const button = chatElement("button", reply.primary ? "cw-chip cw-chip-primary" : "cw-chip");
      button.type = "button";
      button.append(chatElement("span", "cw-chip-emoji", reply.emoji), chatElement("span", "", reply.label));
      button.firstChild.setAttribute("aria-hidden", "true");
      button.addEventListener("click", () => {
        if (reply.action === "cart") {
          setDrawerOpen(true);
        } else if (!isWaiting) {
          sendMessage(reply.message);
        }
      });
      chips.appendChild(button);
    });
    refreshSendButton();
  }

  // After the first customer message the chips move above the input as one compact scrolling row;
  // the Quick options toggle expands them back into the wrapped grid.
  function collapseChips() {
    if (chipsCollapsed) {
      return;
    }
    chipsCollapsed = true;
    quickBar.appendChild(chips);
    quickBar.hidden = chips.childElementCount === 0;
    setChipsExpanded(false);
  }

  function setChipsExpanded(isExpanded) {
    chips.classList.toggle("cw-chips-row", !isExpanded);
    chips.scrollLeft = 0;
    chips.scrollTop = 0;
    quickToggle.setAttribute("aria-expanded", String(isExpanded));
  }

  quickToggle.addEventListener("click", () => setChipsExpanded(chips.classList.contains("cw-chips-row")));

  /* ----- Address in the header ----- */

  // Shown in full when it fits; otherwise it scrolls slowly as a marquee (styles in chat-widget.css,
  // which also turns it into two wrapped lines for reduced motion).
  const MARQUEE_PIXELS_PER_SECOND = 30;

  function showAddress(address) {
    const track = chatElement("span", "cw-subtitle-track");
    const copy = chatElement("span", "cw-subtitle-copy", address);
    const repeat = chatElement("span", "cw-subtitle-copy", address);
    repeat.setAttribute("aria-hidden", "true");
    track.append(copy, repeat);
    subtitle.replaceChildren(track);
    subtitle.title = address;
    subtitle.hidden = false;
    fitAddress();
  }

  function fitAddress() {
    const copy = subtitle.querySelector(".cw-subtitle-copy");
    if (!copy || panel.hidden) {
      return;
    }
    subtitle.classList.remove("cw-marquee");
    const overflows = copy.getBoundingClientRect().width > subtitle.clientWidth + 1;
    subtitle.classList.toggle("cw-marquee", overflows);
    if (overflows) {
      const distance = copy.getBoundingClientRect().width;
      subtitle.style.setProperty("--cw-marquee-duration", `${Math.max(8, distance / MARQUEE_PIXELS_PER_SECOND)}s`);
    }
  }

  // Touch pauses the marquee while a finger is on it, as hover does with a mouse.
  subtitle.addEventListener("touchstart", () => subtitle.classList.add("cw-paused"), { passive: true });
  ["touchend", "touchcancel"].forEach((type) => {
    subtitle.addEventListener(type, () => subtitle.classList.remove("cw-paused"), { passive: true });
  });
  if ("ResizeObserver" in window) {
    new ResizeObserver(fitAddress).observe(subtitle);
  } else {
    window.addEventListener("resize", fitAddress);
  }

  /* ----- Phone sheet height ----- */

  // The visual viewport is the part of the screen not covered by the on-screen keyboard. Sizing the
  // sheet to it keeps the input bar in view while typing, on browsers that don't resize the page.
  const phoneWidth = window.matchMedia("(max-width: 767.98px)");

  function fitSheet() {
    const viewport = window.visualViewport;
    if (!viewport || !phoneWidth.matches || panel.hidden) {
      panel.style.removeProperty("--cw-vh");
      panel.style.removeProperty("--cw-top");
      return;
    }
    panel.style.setProperty("--cw-vh", `${viewport.height}px`);
    panel.style.setProperty("--cw-top", `${viewport.offsetTop}px`);
    scrollToLatest();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitSheet);
    window.visualViewport.addEventListener("scroll", fitSheet);
  }
  phoneWidth.addEventListener("change", fitSheet);

  async function loadConfig() {
    try {
      const config = await requestJson(CHAT_CONFIG_ENDPOINT);
      if (config.address) {
        showAddress(config.address);
      }
      if (config.placeholder) {
        input.placeholder = config.placeholder;
      }
      renderChips(Array.isArray(config.quickReplies) ? config.quickReplies : []);
      if (chipsCollapsed) {
        quickBar.hidden = chips.childElementCount === 0;
      }
    } catch (error) {
      // Without the menu there are no chips; the customer can still type.
      console.error(error);
    }
  }

  /* ----- Cart drawer ----- */

  let cartBusy = false;

  function showCartCount(count) {
    cartCount.textContent = String(count);
    cartCount.hidden = count === 0;
    cartButton.setAttribute("aria-label", `My cart, ${count} item${count === 1 ? "" : "s"}`);
  }

  function quantityButton(label, text, onClick, disabled) {
    const button = chatElement("button", "cw-qty-btn", text);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderCart(cart) {
    showCartCount(cart.itemCount || 0);
    drawerBody.replaceChildren();
    if (cart.lines.length === 0) {
      drawerBody.appendChild(chatElement("p", "cw-drawer-empty", "Your cart is empty. Tap a quick option or ask the assistant to add something."));
      drawerFoot.hidden = true;
      return;
    }

    const list = chatElement("ul", "cw-cart-lines");
    cart.lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const row = chatElement("li", "cw-cart-line");
      const info = chatElement("div", "cw-cart-info");
      const name = chatElement("p", "cw-cart-name", line.name);
      name.dir = "auto";
      info.appendChild(name);
      line.contains.forEach((label) => info.appendChild(chatElement("p", "cw-cart-contains", label)));
      if (!line.orderable) {
        info.appendChild(chatElement("p", "cw-cart-warning", "Can't be ordered right now"));
      }

      const controls = chatElement("div", "cw-cart-controls");
      const disabled = !cart.editable || cartBusy;
      controls.append(
        quantityButton(`One less ${line.name}`, "−", () => changeLine(lineNumber, line.quantity - 1), disabled),
        chatElement("span", "cw-qty", String(line.quantity)),
        quantityButton(`One more ${line.name}`, "+", () => changeLine(lineNumber, line.quantity + 1), disabled)
      );
      const remove = chatElement("button", "cw-remove", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${line.name}`);
      remove.disabled = disabled;
      remove.addEventListener("click", () => changeLine(lineNumber, 0));

      const price = chatElement("p", "cw-cart-price", line.lineTotal || "");
      row.append(info, price, controls, remove);
      list.appendChild(row);
    });
    drawerBody.appendChild(list);

    cartTotal.textContent = cart.total || "To be confirmed";
    drawerFoot.hidden = false;
  }

  function showCartError(message) {
    const error = chatElement("p", "cw-drawer-error", message);
    error.setAttribute("role", "alert");
    drawerBody.prepend(error);
  }

  async function refreshCart() {
    try {
      renderCart(await requestJson(CART_ENDPOINT));
    } catch (error) {
      if (!drawer.hidden) {
        showCartError(error.message);
      }
    }
  }

  async function changeLine(lineNumber, quantity) {
    if (cartBusy || isWaiting) {
      return;
    }
    cartBusy = true;
    drawerBody.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      const cart = await requestJson(CART_LINE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineNumber, quantity }),
      });
      cartBusy = false;
      renderCart(cart);
    } catch (error) {
      cartBusy = false;
      await refreshCart();
      showCartError(error.message);
    }
  }

  function setDrawerOpen(isOpen) {
    drawer.hidden = !isOpen;
    cartButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      refreshCart();
      drawerClose.focus();
    }
  }

  cartButton.addEventListener("click", () => setDrawerOpen(drawer.hidden));
  drawerClose.addEventListener("click", () => {
    setDrawerOpen(false);
    cartButton.focus();
  });
  checkoutButton.addEventListener("click", () => {
    setDrawerOpen(false);
    if (!isWaiting) {
      sendMessage(CHECKOUT_MESSAGE);
    }
  });

  /* ----- Sending ----- */

  // Turns already answered, sent with each message so the assistant remembers the order so far.
  const conversationHistory = [];
  // Messages from menu Order buttons clicked while a reply is still on its way.
  const queuedMessages = [];
  // Item id -> id of its Order click the server hasn't answered for yet. If the answer never arrives
  // (a dropped connection), the item may or may not have gone in, so the customer's next click on it
  // is sent as the same click: the server adds it at most once. A new id is only made once the server
  // has answered, when the customer can see the cart and another click means they want another.
  const unansweredClicks = new Map();
  let isWaiting = false;

  function refreshSendButton() {
    sendButton.disabled = isWaiting || input.value.trim() === "";
    panel.classList.toggle("cw-waiting", isWaiting);
    chips.querySelectorAll(".cw-chip").forEach((chip) => {
      chip.disabled = isWaiting;
    });
    checkoutButton.disabled = isWaiting;
  }

  async function sendMessage(text, orderItem) {
    addBubble(text, "user");
    collapseChips();
    isWaiting = true;
    refreshSendButton();

    const typing = showTyping();
    try {
      const { reply, clickStatus, cart } = await requestOrderTakerReply(text, conversationHistory, orderItem);
      addBubble(reply, "bot");
      conversationHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (orderItem && clickStatus) {
        unansweredClicks.delete(orderItem.item_id);
      }
      if (cart) {
        addBubble(describeCartForCustomer(cart), "bot").classList.add("cw-bubble-cart");
      }
    } catch (error) {
      // Failed turns stay out of the history so the next attempt starts clean.
      addBubble(error.message, "bot");
    } finally {
      typing.remove();
      isWaiting = false;
      refreshSendButton();
      refreshCart();
      if (window.matchMedia("(hover: hover)").matches) {
        input.focus();
      }
    }

    if (queuedMessages.length > 0) {
      const next = queuedMessages.shift();
      sendMessage(next.text, next.orderItem);
    }
  }

  input.addEventListener("input", refreshSendButton);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || isWaiting) {
      return;
    }
    input.value = "";
    sendMessage(text);
  });

  // Menu Order buttons send the item's id; the name is only for the message the customer reads.
  // The server looks up the price. The menu is drawn after this runs, so the click is caught on
  // its container.
  document.getElementById("menu-root").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-item-id]");
    if (!button) {
      return;
    }
    const itemName = button.closest(".product, .deal").querySelector("h4").textContent.trim();
    const text = `I'd like to order 1 x ${itemName}.`;
    const itemId = button.dataset.itemId;
    const clickId = unansweredClicks.get(itemId) || newClickId();
    unansweredClicks.set(itemId, clickId);
    const orderItem = { item_id: itemId, quantity: 1, option_ids: [], click_id: clickId };
    setOpen(true);
    if (isWaiting) {
      queuedMessages.push({ text, orderItem });
    } else {
      sendMessage(text, orderItem);
    }
  });

  loadConfig();
  refreshCart();
}

setupChatWidget();
