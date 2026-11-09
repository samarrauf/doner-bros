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
    // The popup opens in the top layer, above everything, so it waits for the intro splash to go.
    Promise.resolve(window.donerSplash).then(() => modal.showModal());
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
        // Scroll only the strip: scrollIntoView would also cancel the page's own smooth scroll to the section.
        const strip = tab.parentElement;
        const offset = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left;
        strip.scrollTo({ left: strip.scrollLeft + offset - (strip.clientWidth - tab.offsetWidth) / 2, behavior: "smooth" });
      } else {
        tab.removeAttribute("aria-current");
      }
    });
  }

  // While a clicked tab's smooth scroll runs, tracking must not change the active tab.
  let clickLock = false;
  let settleTimer = null;
  // Sections in the band, oldest entry first. Kept up to date during a lock, so a user
  // scroll that ends the lock can pick up the section they are actually on.
  const sectionsInBand = new Set();

  function releaseClickLock() {
    clickLock = false;
    clearInterval(settleTimer);
  }

  function watchForSettle() {
    const supportsScrollEnd = "onscrollend" in window;
    let lastY = window.scrollY;
    clearInterval(settleTimer);
    settleTimer = setInterval(() => {
      if (window.scrollY === lastY) {
        // Settled, or the section was already in place so no scroll (and no scrollend) ever happens.
        releaseClickLock();
      } else if (supportsScrollEnd) {
        clearInterval(settleTimer);
      } else {
        lastY = window.scrollY;
      }
    }, 150);
  }

  function onUserScroll() {
    if (!clickLock) {
      return;
    }
    releaseClickLock();
    const current = Array.from(sectionsInBand).pop();
    if (current) {
      setActive(current);
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.getAttribute("href").slice(1);
      setActive(id);
      clickLock = true;
      // The browser drops an anchor jump made during a smooth scroll, so a second click would
      // highlight this tab but land on the first one. This scroll replaces the running one.
      document.getElementById(id).scrollIntoView({ behavior: "smooth" });
      watchForSettle();
    });
  });

  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  const stripElement = document.getElementById("category-tabs");
  window.addEventListener("scrollend", () => {
    if (clickLock) {
      releaseClickLock();
    }
  });
  window.addEventListener("wheel", onUserScroll, { passive: true });
  // A swipe along the tab strip moves the strip, not the page.
  window.addEventListener("touchmove", (event) => {
    if (!stripElement.contains(event.target)) {
      onUserScroll();
    }
  }, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (SCROLL_KEYS.has(event.key)) {
      onUserScroll();
    }
  });
  // A press on the page scrollbar lands on the root element.
  window.addEventListener("mousedown", (event) => {
    if (event.target === document.documentElement) {
      onUserScroll();
    }
  });

  // A section counts as "current" once it reaches the band just below the sticky bars.
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        sectionsInBand.add(entry.target.id);
        if (!clickLock) {
          setActive(entry.target.id);
        }
      } else {
        sectionsInBand.delete(entry.target.id);
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

    const foot = createElement("div", "product-foot");
    foot.appendChild(createElement("p", "deal-price", deal.priceDisplay));
    const orderButton = createElement("button", "btn btn-small", "Order");
    orderButton.type = "button";
    orderButton.dataset.itemId = deal.id;
    orderButton.setAttribute("aria-label", `Order ${deal.name}`);
    foot.appendChild(orderButton);
    card.appendChild(foot);

    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

function renderMenu({ categories, deals }) {
  const root = document.getElementById("menu-root");
  const tabs = document.getElementById("category-tabs");

  const hasDeals = Array.isArray(deals) && deals.length > 0;

  if (hasDeals) {
    const dealsTab = createElement("a", "tab-deals is-active", "Deals");
    dealsTab.href = "#deals";
    tabs.appendChild(dealsTab);
  }

  categories.forEach((category, index) => {
    const tab = createElement("a", index === 0 && !hasDeals ? "is-active" : "", category.name);
    tab.href = `#cat-${category.slug}`;
    tabs.appendChild(tab);
  });

  root.replaceChildren();
  if (hasDeals) {
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
  } finally {
    // Tells the intro splash the menu has arrived (or failed), so it can step aside.
    document.dispatchEvent(new Event("donerbros:menu-settled"));
  }
}

applyPhone(FALLBACK_WHATSAPP);
setupLocationPopup();
loadMenu();
