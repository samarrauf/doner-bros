# CLAUDE.md — Doner Bros

Guidance for Claude when working in this repository. Read this first, follow it always.

## Project Purpose

Doner Bros is the digital presence for a doner kebab restaurant. The goal is a fast,
mobile-friendly app that lets customers:

- Browse the menu (doners, wraps, plates, sides, drinks) with prices and allergens
- Customise items (meat, sauces, salad, extras) and place orders for pickup or delivery
- Pay securely online or choose pay-on-collection
- See opening hours, location, and contact details

Staff use a simple admin area to manage menu items, prices, availability, and incoming orders.

## Architecture Overview

> The stack is not fixed yet. Update this section once it's chosen; keep it short.

```
[ Customer web app ]   [ Admin dashboard ]
          \                 /
           \               /
          [ Backend API (REST) ]
           /        |         \
   [ Database ]  [ Payments ]  [ Notifications ]
   menu, orders  (Stripe or     (email/SMS order
   users         similar)        confirmations)
```

- **Frontend** — customer-facing pages: menu, cart, checkout, order status, info pages.
- **Admin** — authenticated staff area for menu and order management.
- **Backend API** — business logic: pricing, order validation, order state, auth.
- **Database** — source of truth for menu, orders, and staff accounts.
- **Third-party services** — payments and notifications go through their official SDKs only.

Planned folder layout (adjust when the stack is set):

```
/frontend   customer app
/admin      staff dashboard (may live inside /frontend)
/backend    API, services, data access
/docs       decisions and notes
```

## Coding Rules

- Keep it simple. Prefer clear, boring code over clever code.
- Match the existing style, naming, and patterns of the file you're editing.
- Small functions with one job; descriptive names (`calculateOrderTotal`, not `calc`).
- All prices are calculated on the **backend**. Never trust totals sent from the client.
- Store money as integer minor units (e.g. pence/cents), never floating point.
- Validate all input at the API boundary; return clear error messages.
- Handle errors explicitly — no silent catches.
- Don't add new dependencies without a clear reason; mention it when you do.
- Write or update tests for business logic (pricing, order flow) when changing it.
- Comments explain *why*, not *what*. Don't over-comment.

## Security Rules

- **Never commit secrets.** API keys, DB passwords, and payment keys live in `.env` files,
  which must be in `.gitignore`. Provide a `.env.example` with placeholder values only.
- Never hard-code credentials, tokens, or real customer data in code, tests, or docs.
- Use parameterised queries / an ORM — no string-built SQL.
- Escape or sanitise anything rendered from user input (XSS protection).
- Card details are handled only by the payment provider's hosted fields/SDK. Our servers
  never see or store card numbers.
- Admin routes require authentication and authorisation checks on the **server**.
- Hash passwords with a modern algorithm (bcrypt/argon2). Never log passwords or tokens.
- Collect only the customer data needed to fulfil an order (name, contact, address).
- Use HTTPS everywhere; set secure, HTTP-only cookies for sessions.
- Rate-limit login and order endpoints.

## Token-Saving Rules

- Read only the files relevant to the task. Don't scan the whole repo "just in case".
- Use search (Grep/Glob) to locate code before opening files; read the needed section, not
  the whole file, when files are large.
- Don't re-read files you've just edited or already have in context.
- Skip `node_modules/`, build output, lock files, and generated files.
- Keep responses concise: say what changed and why, not a line-by-line replay.
- Don't paste large code blocks back into chat when the edit is already in the file.
- Ask a short clarifying question instead of guessing on large, ambiguous tasks.

## Scope Rule — Only Touch What the Task Needs

**Only modify files that are necessary for the current task.**

- No drive-by refactors, renames, reformatting, or "while I'm here" fixes.
- If you notice an unrelated problem, mention it — don't fix it unasked.
- Don't create new files (docs, helpers, configs) unless the task requires them.
- Keep diffs as small as possible while fully solving the task.
