// The homepage intro splash (frontend/index.html): when it shows, and how long it stays.
// The rule runs inline in the page before anything paints, so this test runs that same block.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX = path.join(__dirname, "..", "frontend", "index.html");
const CSS = path.join(__dirname, "..", "frontend", "styles.css");
const html = fs.readFileSync(INDEX, "utf8");

function loadRule() {
  const match = html.match(/\/\* splash-rule:start[^*]*\*\/([\s\S]*?)\/\* splash-rule:end \*\//);
  assert.ok(match, "index.html has the splash-rule block");
  // eslint-disable-next-line no-new-func
  return new Function(`${match[1]}; return { SPLASH_TIMING, shouldShowSplash, splashFadeStartMs };`)();
}
const { SPLASH_TIMING, shouldShowSplash, splashFadeStartMs } = loadRule();
const SITE = "https://doner-bros.vercel.app";

test("a page reload always shows the splash, even when the referrer is this site", () => {
  assert.equal(shouldShowSplash("reload", "", SITE, ""), true);
  assert.equal(shouldShowSplash("reload", `${SITE}/`, SITE, ""), true);
  assert.equal(shouldShowSplash("reload", `${SITE}/kitchen/login`, SITE, ""), true);
});

test("a fresh visit shows it: new tab, typed URL, bookmark, or a link from another site", () => {
  assert.equal(shouldShowSplash("navigate", "", SITE, ""), true, "no referrer (new tab, typed, bookmark)");
  assert.equal(shouldShowSplash("navigate", "https://www.google.com/", SITE, ""), true);
  assert.equal(shouldShowSplash("navigate", "https://doner-bros.vercel.app.evil.example/", SITE, ""), true, "look-alike host is outside");
  assert.equal(shouldShowSplash("navigate", "http://doner-bros.vercel.app/", SITE, ""), true, "different scheme is a different origin");
  assert.equal(shouldShowSplash("navigate", "not a url", SITE, ""), true);
});

test("navigation inside the site skips it", () => {
  assert.equal(shouldShowSplash("navigate", `${SITE}/kitchen/login`, SITE, ""), false);
  assert.equal(shouldShowSplash("navigate", `${SITE}/#menu`, SITE, ""), false);
  assert.equal(shouldShowSplash("back_forward", `${SITE}/owner/login`, SITE, ""), false);
});

test("?splash=1 forces it, wherever the visitor came from", () => {
  assert.equal(shouldShowSplash("navigate", `${SITE}/`, SITE, "?splash=1"), true);
  assert.equal(shouldShowSplash("navigate", `${SITE}/`, SITE, "?a=b&splash=1"), true);
  assert.equal(shouldShowSplash("navigate", `${SITE}/`, SITE, "?splash=10"), false);
  assert.equal(shouldShowSplash("navigate", `${SITE}/`, SITE, "?nosplash=1"), false);
});

test("timing: at least 3 s on screen, about 3.5 s in all, never past 4 s", () => {
  assert.deepEqual(SPLASH_TIMING, { VISIBLE_MIN_MS: 3000, FADE_MS: 500, TOTAL_MAX_MS: 4000 });
  assert.equal(splashFadeStartMs(200), 3000, "a fast page still waits: 3 s + 0.5 s fade = 3.5 s");
  assert.equal(splashFadeStartMs(3200), 3200, "a slower page: fade starts once it is ready");
  assert.equal(splashFadeStartMs(9000), 3500, "a very slow page: fade starts by 3.5 s, gone by 4 s");
  assert.equal(splashFadeStartMs(null), 3500, "the safety timer");
  for (const ready of [0, 1000, 3000, 3400, 3500, 5000, null]) {
    const end = splashFadeStartMs(ready) + SPLASH_TIMING.FADE_MS;
    assert.ok(end >= 3500 && end <= SPLASH_TIMING.TOTAL_MAX_MS, `ends between 3.5 and 4 s (ready ${ready})`);
  }
});

test("the page reads the navigation type, not sessionStorage, and has the new content", () => {
  assert.match(html, /performance\.getEntriesByType\("navigation"\)\[0\]/);
  assert.match(html, /shouldShowSplash\(navType, document\.referrer, location\.origin, location\.search\)/);
  assert.doesNotMatch(html, /splashSeen|sessionStorage/, "no once-per-session gate any more");
  assert.match(html, /<p class="splash-welcome">Welcome to Doner Bros<\/p>/);
  assert.match(html, /class="splash-line"/);
  const css = fs.readFileSync(CSS, "utf8");
  assert.match(css, /animation: splash-blink 1s ease-in-out [\d.]+s infinite/, "logo blinks about once a second, all the way through");
  assert.match(css, /height: 100dvh/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*splash-failsafe/, "reduced motion keeps the fade and failsafe");
});
