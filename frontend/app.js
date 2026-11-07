// Doner Bros — landing page interactions: location popup, menu and hero from /api/menu, category tabs.

const STORAGE_KEY = "donersBros.location";

/* ---------- Location popup ---------- */

function readSavedLocation() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    // Storage can be blocked (private mode); the popup still works without it.
    return null;
  }
}

function saveLocation(location) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch (error) {
    // Not critical: the choice just won't be remembered on the next visit.
  }
}

function describeLocation(location) {
  if (location.orderType === "pickup") {
    return "Pick-up";
  }
  return `Delivery · ${location.area}`;
}

function setupLocationPopup() {
  const modal = document.getElementById("location-modal");
  const form = document.getElementById("location-form");
  const areaField = document.getElementById("area-field");
  const areaSelect = document.getElementById("area");
  const pickupBranch = document.getElementById("pickup-branch");
  const prompt = document.getElementById("location-prompt");
  const submitButton = document.getElementById("location-submit");
  const closeButton = document.getElementById("location-close");
  const chip = document.getElementById("location-chip");
  const chipLabel = document.getElementById("location-label");

  if (!modal || typeof modal.showModal !== "function") {
    return;
  }

  function selectedOrderType() {
    return form.querySelector('input[name="orderType"]:checked').value;
  }

  function refreshForm() {
    const isPickup = selectedOrderType() === "pickup";
    areaField.hidden = isPickup;
    pickupBranch.hidden = !isPickup;
    prompt.textContent = isPickup ? "Pick up from our branch" : "Please select your location";
    submitButton.disabled = !isPickup && !areaSelect.value;
  }

  function applyLocation(location) {
    chipLabel.textContent = describeLocation(location);
    form.querySelector(`input[value="${location.orderType}"]`).checked = true;
    if (location.area) {
      areaSelect.value = location.area;
    }
    refreshForm();
  }

  form.addEventListener("change", refreshForm);

  form.addEventListener("submit", () => {
    const location = {
      orderType: selectedOrderType(),
      city: form.city.value,
      area: selectedOrderType() === "pickup" ? "" : areaSelect.value,
    };
    saveLocation(location);
    chipLabel.textContent = describeLocation(location);
  });

  closeButton.addEventListener("click", () => modal.close());
  chip.addEventListener("click", () => modal.showModal());

  // Close when the dimmed backdrop (outside the form) is clicked.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.close();
    }
  });

  const saved = readSavedLocation();
  if (saved) {
    applyLocation(saved);
  } else {
    refreshForm();
    modal.showModal();
  }
}

/* ---------- Menu category tabs ---------- */

function setupCategoryTabs() {
  const tabs = Array.from(document.querySelectorAll("#category-tabs a"));
  const sections = tabs
    .map((tab) => document.querySelector(tab.getAttribute("href")))
    .filter(Boolean);

  if (!("IntersectionObserver" in window) || sections.length === 0) {
    return;
  }

  function setActive(id) {
    tabs.forEach((tab) => {
      const isActive = tab.getAttribute("href") === `#${id}`;
      tab.classList.toggle("is-active", isActive);
      if (isActive) {
        tab.setAttribute("aria-current", "true");
        tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      } else {
        tab.removeAttribute("aria-current");
      }
    });
  }

  // A section counts as "current" once it reaches the band just below the sticky bars.
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        setActive(entry.target.id);
      }
    });
  }, { rootMargin: "-140px 0px -60% 0px" });

  sections.forEach((section) => observer.observe(section));
}

/* ---------- Menu and hero, rendered from /api/menu ---------- */

const MENU_ENDPOINT = "/api/menu";
// The only hardcoded contact detail: what a customer gets if /api/menu can't be reached.
// Everything else on the page comes from the whatsapp and address settings.
const FALLBACK_WHATSAPP = "03103994111";
// Number of category colours defined in styles.css (.category[data-tone]).
const CATEGORY_TONES = 6;

// Text goes in through textContent, so menu data is never treated as HTML.
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function safeImageUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (error) {
    return null;
  }
}

function parsePhone(value) {
  const digits = String(value).replace(/\D/g, "").replace(/^92/, "0");
  return { display: `${digits.slice(0, 4)}-${digits.slice(4)}`, international: `92${digits.slice(1)}` };
}

let contactPhone = parsePhone(FALLBACK_WHATSAPP);

function applyPhone(value) {
  contactPhone = parsePhone(value);
  document.querySelectorAll("[data-phone-link]").forEach((link) => {
    link.href = `tel:+${contactPhone.international}`;
  });
  document.querySelectorAll("[data-phone-text]").forEach((element) => {
    element.textContent = contactPhone.display;
  });
}

function applyAddress(address) {
  document.querySelectorAll("[data-address-text]").forEach((element) => {
    element.textContent = address;
  });
  document.querySelectorAll("[data-directions-link]").forEach((link) => {
    link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  });
  document.querySelectorAll("[data-needs-address]").forEach((element) => {
    element.hidden = false;
  });
}

function applyHeroPhoto(settings) {
  const photoUrl = safeImageUrl(settings.hero_image_url);
  if (!photoUrl) {
    return;
  }

  // Swap the photo in only once it has loaded; if it fails the hero stays brand-coloured.
  const photo = new Image();
  photo.addEventListener("load", () => {
    const hero = document.querySelector(".hero");
    hero.style.setProperty("--hero-photo", `url("${photoUrl}")`);
    hero.classList.add("has-photo");
  });
  photo.src = photoUrl;
}

function applyLogo(settings) {
  const logoUrl = safeImageUrl(settings.brand_logo_url);
  if (!logoUrl) {
    return;
  }

  // Swap the logo in only once it has loaded; if it fails the built-in file stays.
  const logo = new Image();
  logo.addEventListener("load", () => {
    document.querySelectorAll('img[src="images/logo.png"]').forEach((image) => {
      image.style.objectFit = "contain"; // Their width and height are square; never stretch another shape.
      image.src = logoUrl;
    });
    const icon = document.querySelector('link[rel="icon"]');
    icon.type = "image/webp";
    icon.href = logoUrl;
  });
  logo.src = logoUrl;
}

function buildItemCard(item) {
  const card = createElement("article", "product");
  const photoUrl = safeImageUrl(item.imageUrl);

  if (photoUrl) {
    const frame = createElement("div", "product-img");
    const image = document.createElement("img");
    image.alt = item.name;
    image.loading = "lazy";
    // A photo that fails to load falls back to the photo-free card, never a broken image.
    image.addEventListener("error", () => {
      frame.remove();
      card.classList.add("product-plain");
    });
    image.src = photoUrl;
    frame.appendChild(image);
    card.appendChild(frame);
  } else {
    card.classList.add("product-plain");
  }

  const info = createElement("div", "product-info");
  info.appendChild(createElement("h4", "", item.name));

  const foot = createElement("div", "product-foot");
  foot.appendChild(createElement("span", "price", item.priceDisplay));

  const orderButton = createElement("button", "btn btn-small", "Order");
  orderButton.type = "button";
  orderButton.dataset.itemId = item.id;
  orderButton.setAttribute("aria-label", `Order ${item.name}`);
  foot.appendChild(orderButton);

  info.appendChild(foot);
  card.appendChild(info);
  return card;
}

function buildCategorySection(category, index) {
  const section = createElement("section", "category");
  section.id = `cat-${category.slug}`;
  section.dataset.tone = String(index % CATEGORY_TONES);
  section.setAttribute("aria-labelledby", `h-${category.slug}`);

  const title = createElement("h3", "category-title", category.name);
  title.id = `h-${category.slug}`;
  section.appendChild(title);

  if (category.items.length === 0) {
    section.appendChild(createElement("p", "menu-status", "Nothing available in this category right now."));
    return section;
  }

  const grid = createElement("div", "product-grid");
  category.items.forEach((item) => grid.appendChild(buildItemCard(item)));
  section.appendChild(grid);
  return section;
}

function buildDealsSection(deals) {
  const section = createElement("section", "category");
  section.id = "deals";
  section.setAttribute("aria-labelledby", "h-deals");

  const title = createElement("h3", "category-title", "Deals");
  title.id = "h-deals";
  section.appendChild(title);

  const grid = createElement("div", "product-grid");
  deals.forEach((deal) => {
    const card = createElement("article", "deal");
    card.appendChild(createElement("h4", "", deal.name));
    const contents = createElement("ul", "deal-items");
    deal.items.forEach((dealItem) => contents.appendChild(createElement("li", "", dealItem.label)));
    card.appendChild(contents);
    card.appendChild(createElement("p", "deal-price", deal.priceDisplay));
    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

function renderMenu({ categories, deals }) {
  const root = document.getElementById("menu-root");
  const tabs = document.getElementById("category-tabs");

  categories.forEach((category, index) => {
    const tab = createElement("a", index === 0 ? "is-active" : "", category.name);
    tab.href = `#cat-${category.slug}`;
    tabs.appendChild(tab);
  });

  root.replaceChildren();
  if (Array.isArray(deals) && deals.length > 0) {
    root.appendChild(buildDealsSection(deals));
  }
  categories.forEach((category, index) => root.appendChild(buildCategorySection(category, index)));

  document.getElementById("category-bar").hidden = false;
  setupCategoryTabs();
}

function showMenuLoading() {
  const status = createElement("p", "menu-status", "Loading the menu…");
  status.setAttribute("role", "status");
  document.getElementById("menu-root").replaceChildren(status);
}

function showMenuError() {
  const message = createElement("p", "menu-status", "Sorry, the menu could not be loaded. Message us on WhatsApp: ");
  message.setAttribute("role", "alert");
  const link = createElement("a", "", contactPhone.display);
  link.href = `https://wa.me/${contactPhone.international}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  message.appendChild(link);
  document.getElementById("menu-root").replaceChildren(message);
}

async function loadMenu() {
  showMenuLoading();
  try {
    const response = await fetch(MENU_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Menu request failed with status ${response.status}`);
    }
    const menu = await response.json();
    const settings = menu.settings || {};
    applyLogo(settings);
    if (settings.whatsapp) {
      applyPhone(settings.whatsapp);
    }
    if (settings.address) {
      applyAddress(settings.address);
    }
    if (!Array.isArray(menu.categories) || menu.categories.length === 0) {
      throw new Error("Menu response had no categories");
    }
    renderMenu(menu);
    applyHeroPhoto(settings);
  } catch (error) {
    console.error(error);
    showMenuError();
  }
}

/* ---------- AI Order Taker chat widget ---------- */

const CHAT_ENDPOINT = "/api/chat";
function chatFallbackError() {
  return `Sorry, I couldn't reach AI Order Taker. Please try again, or call us on ${contactPhone.display}.`;
}

// Sends the message and prior turns to the backend; resolves with AI Order Taker's reply text.
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
  return data.reply;
}

function setupChatWidget() {
  const toggle = document.getElementById("chat-toggle");
  const chatWindow = document.getElementById("chat-window");
  const closeButton = document.getElementById("chat-close");
  const messages = document.getElementById("chat-messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const sendButton = document.getElementById("chat-send");

  function setOpen(isOpen) {
    chatWindow.hidden = !isOpen;
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close chat" : "Open chat");
    if (isOpen) {
      input.focus();
    }
  }

  function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addBubble(text, sender) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${sender}`;
    // textContent (not innerHTML) so customer text is never treated as HTML.
    bubble.textContent = text;
    messages.appendChild(bubble);
    scrollToLatest();
    return bubble;
  }

  function showTyping() {
    const typing = document.createElement("div");
    typing.className = "chat-bubble chat-bubble-bot chat-typing";
    typing.setAttribute("aria-label", "AI Order Taker is typing");
    typing.innerHTML = "<span></span><span></span><span></span>";
    messages.appendChild(typing);
    scrollToLatest();
    return typing;
  }

  toggle.addEventListener("click", () => setOpen(chatWindow.hidden));
  closeButton.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });

  chatWindow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      toggle.focus();
    }
  });

  // Turns already answered, sent with each message so AI Order Taker remembers the order so far.
  const conversationHistory = [];
  // Messages from menu Order buttons clicked while a reply is still on its way.
  const queuedMessages = [];
  let isWaiting = false;

  function refreshSendButton() {
    sendButton.disabled = isWaiting || input.value.trim() === "";
  }

  async function sendMessage(text, orderItem) {
    addBubble(text, "user");
    isWaiting = true;
    refreshSendButton();

    const typing = showTyping();
    try {
      const reply = await requestOrderTakerReply(text, conversationHistory, orderItem);
      addBubble(reply, "bot");
      conversationHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
    } catch (error) {
      // Failed turns stay out of the history so the next attempt starts clean.
      addBubble(error.message, "bot");
    } finally {
      typing.remove();
      isWaiting = false;
      refreshSendButton();
      input.focus();
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
    const itemName = button.closest(".product").querySelector("h4").textContent.trim();
    const text = `I'd like to order 1 x ${itemName}.`;
    const orderItem = { item_id: button.dataset.itemId, quantity: 1, option_ids: [] };
    setOpen(true);
    if (isWaiting) {
      queuedMessages.push({ text, orderItem });
    } else {
      sendMessage(text, orderItem);
    }
  });
}

applyPhone(FALLBACK_WHATSAPP);
setupLocationPopup();
setupChatWidget();
loadMenu();
