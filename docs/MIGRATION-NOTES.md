# Menu architecture

The menu lives in Supabase. Nothing else holds it. `data/menu.json`, `data/promotions.json` and
`data/pricing.json` are gone. Item names and prices are left out of this page on purpose.

```
Supabase ──> backend/services/menu-service.js ──┬──> /api/menu ──> website
                                                ├──> backend/menu-tool.js ──> AI agent
                                                └──> backend/totals.js ──> cart, orders
```

## Supabase is the source of truth

Tables: `menu_categories`, `menu_items`, `menu_deals`, `menu_deal_items` and `menu_settings`
(tax, delivery fee, contact details, images). Prices are integer paisa. The schema is in
`supabase/migrations/`, and `supabase/seed/0001_menu_data.sql` is the one file allowed to contain
menu data. To change a price, change the row.

The backend connects with the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables.

## menu-service is the only reader

`backend/services/menu-service.js` is the only code that reads menu tables. It holds one snapshot
for 60 seconds (`CACHE_TTL_MS`), so a change in Supabase reaches customers within a minute. If the
read fails it retries once, then reports the menu as unavailable. It never falls back to stored data.

- Backend code uses `getSettings()`. Anything sent to the browser uses `getPublicSettings()`,
  which returns only an allow-listed set of keys.
- Staff photo uploads (`backend/menu-images.js`) write image URLs to those tables. They look up only
  a row's id to confirm it exists, and new photos reach customers when the cache expires.

## /api/menu serves the site

`frontend/app.js` builds the menu, deals and prices on the page from `/api/menu`. The HTML holds no
items or prices. A failed read returns a 503 with no menu data.

## The agent uses tools

The agent gets menu data only from tool calls in `backend/menu-tool.js`: `list_categories`,
`list_items`, `search_items`, `get_item` and `list_deals`. None of them accepts a price.

- **Totals:** the agent never adds anything up. `backend/totals.js` prices carts from ids and
  quantities, ignoring any price sent with them, and rejects unknown or finished items.
- **Price guard:** `backend/price-guard.js` checks each reply. An amount no tool returned that turn
  is not sent; the reply is regenerated once, then replaced with a fallback message.
- **Saved orders:** `orders.items` keeps its own copy of names and prices, so later menu changes
  don't alter past orders.

## Tests

Tests never touch Supabase or the real menu. `backend/fake-menu.js` serves made-up items through the
real menu service, and is the one place test prices are written. Tests read prices from it and work
out what they expect.

## What is still a file

`data/hours.json` (opening hours) and `prompts/system-prompt.md` (agent instructions). Neither is
menu data, and `vercel.json` still bundles both.
