# Menu migration notes

A map of the system before the menu moves to Supabase. Written at the start of the
`menu-supabase` branch. Item names and prices are left out on purpose.

## Where menu data is hardcoded today

| File | What it holds |
|---|---|
| `frontend/index.html` | Hero slide 2 (item and price), category tabs, all menu cards (from line 222) |
| `data/menu.json` | Categories and items: IDs, prices in paisa, options, allergens, tags, availability |
| `data/promotions.json` | Offers. Three samples only, all inactive; no real deals exist yet |
| `data/pricing.json` | Tax percent and delivery fee |
| `prompts/system-prompt.md` | Example items and prices in the "Example behaviour" section (line 117) |

The website copy and `data/menu.json` are separate. Nothing keeps them in step.

## Files that read the menu

| File | How it uses the menu |
|---|---|
| `backend/server.js` | Loads `menu.json`, `promotions.json` and `pricing.json` once at startup (line 170); puts the menu and offers in the AI prompt; passes the menu to cart, order and suggestion code |
| `backend/menu-tool.js` | The `getMenu` AI tool; reads `menu.json` from disk on every call |
| `backend/orders.js` | Checks and prices cart lines and orders; checks promotions |
| `backend/recommendations.js` | Picks add-on suggestions |
| `frontend/app.js` | Reads the item name from a menu card and sends it to the chat (line 385) |
| `vercel.json` | Bundles the `data` folder into the deployment |

`backend/totals.js` works out totals from lines already priced by `orders.js`, using the
tax and delivery settings from `pricing.json`.

These nine test files load the real `data/menu.json`: `apply-promotion`, `delivery`,
`order-session`, `orders`, `order-summary`, `pickup`, `supabase-orders`, `totals` and
`recommendations` (all `backend/*.test.js`).

Saved orders keep their own copy of item names and prices in `orders.items`, so menu changes
do not alter past orders. The staff dashboard reads from that copy.

## Supabase tables that exist

All are accessed only through the backend with the service role key. None holds menu data.

| Table | Purpose | Defined in |
|---|---|---|
| `orders` | Customer orders | `supabase/orders.sql` |
| `chat_sessions` | Chats in progress, including carts | `supabase/chat-sessions.sql` |
| `rate_limit_hits` | Rate limit counts, used through the `rate_limit_hit` function | `supabase/chat-sessions.sql` |

Connection settings come from the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment
variables, read in `backend/server.js` (line 281).

## Differences to resolve against the new CLAUDE.md

- **Delivery fee:** `data/pricing.json` has it unset (`null`); the rules say it is currently 0.
- **Phone:** the website's Call and Order links use a different number from the WhatsApp number in the rules.
- **Location name:** the website says "Shalimar City"; the rules say "Food Court, Shalimar Smart City".
- **GST:** the website says prices include GST; `data/pricing.json` says tax is unconfirmed.
