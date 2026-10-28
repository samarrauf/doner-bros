// Doner Bros — landing page interactions: location popup, hero slider, menu category tabs.

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
    return "Pick-up · Shalimar City";
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
      area: selectedOrderType() === "pickup" ? "Shalimar City" : areaSelect.value,
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

/* ---------- Hero slider ---------- */

const SLIDE_INTERVAL_MS = 6000;

function setupHeroSlider() {
  const hero = document.querySelector(".hero");
  const track = document.getElementById("slides");
  const slides = Array.from(track.querySelectorAll(".slide"));
  const dots = Array.from(document.querySelectorAll("#slide-dots button"));
  const prevButton = document.getElementById("slide-prev");
  const nextButton = document.getElementById("slide-next");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let current = 0;
  let timer = null;

  function goTo(index) {
    current = (index + slides.length) % slides.length;
    track.style.transform = `translateX(-${current * 100}%)`;

    slides.forEach((slide, i) => {
      const isActive = i === current;
      slide.classList.toggle("is-active", isActive);
      slide.setAttribute("aria-hidden", String(!isActive));
      // Keep links in hidden slides out of the keyboard tab order.
      slide.querySelectorAll("a").forEach((link) => {
        link.tabIndex = isActive ? 0 : -1;
      });
    });

    dots.forEach((dot, i) => {
      const isActive = i === current;
      dot.classList.toggle("is-active", isActive);
      if (isActive) {
        dot.setAttribute("aria-current", "true");
      } else {
        dot.removeAttribute("aria-current");
      }
    });

    hero.classList.toggle("on-light", slides[current].classList.contains("slide-2"));
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  function start() {
    if (reduceMotion || timer) {
      return;
    }
    timer = setInterval(() => goTo(current + 1), SLIDE_INTERVAL_MS);
  }

  function restart() {
    stop();
    start();
  }

  prevButton.addEventListener("click", () => {
    goTo(current - 1);
    restart();
  });

  nextButton.addEventListener("click", () => {
    goTo(current + 1);
    restart();
  });

  dots.forEach((dot, i) => {
    dot.addEventListener("click", () => {
      goTo(i);
      restart();
    });
  });

  // Pause while the visitor is reading or interacting with a slide.
  hero.addEventListener("mouseenter", stop);
  hero.addEventListener("mouseleave", start);
  hero.addEventListener("focusin", stop);
  hero.addEventListener("focusout", start);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  let touchStartX = null;

  hero.addEventListener("touchstart", (event) => {
    touchStartX = event.touches[0].clientX;
    stop();
  }, { passive: true });

  hero.addEventListener("touchend", (event) => {
    if (touchStartX === null) {
      return;
    }
    const distance = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(distance) > 50) {
      goTo(distance < 0 ? current + 1 : current - 1);
    }
    touchStartX = null;
    start();
  });

  goTo(0);
  start();
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

/* ---------- CafeBot chat widget ---------- */

// Fixed mock reply: no API is called until the AI backend exists.
const CAFEBOT_REPLY = "Hi! I'm CafeBot. My AI brain isn't connected yet.";
const CAFEBOT_DELAY_MS = 700;

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
    typing.setAttribute("aria-label", "CafeBot is typing");
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

  input.addEventListener("input", () => {
    sendButton.disabled = input.value.trim() === "";
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }

    addBubble(text, "user");
    input.value = "";
    sendButton.disabled = true;

    const typing = showTyping();
    setTimeout(() => {
      typing.remove();
      addBubble(CAFEBOT_REPLY, "bot");
    }, CAFEBOT_DELAY_MS);
  });
}

setupLocationPopup();
setupHeroSlider();
setupCategoryTabs();
setupChatWidget();
