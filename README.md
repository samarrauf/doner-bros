# Doner Bros

Web app for the Doner Bros doner kebab restaurant: menu, AI Order Taker chat, and a staff
dashboard for orders. Orders are saved to Supabase.

## Structure

```
frontend/   customer-facing site (index.html, styles.css, app.js)
admin/      login pages, kitchen board, owner dashboard and photo pages
backend/    Express server and API code
data/       menu, pricing and restaurant details
prompts/    AI Order Taker system prompt
supabase/   SQL for the orders, chat sessions and rate limit tables
server.js   Vercel's entrypoint; it loads the app from backend/server.js
vercel.json Vercel build settings
CLAUDE.md   guidance for Claude
```

## Requirements

- Node.js 18 or newer
- A Supabase project with the tables from `supabase/orders.sql` and `supabase/chat-sessions.sql`
- An Anthropic API key for the AI Order Taker

## Setup

1. Copy `.env.example` to `.env` in the project root and fill in the values. Never commit `.env`.
2. In Supabase, open **SQL Editor** → **New query** and run `supabase/orders.sql`, then
   `supabase/chat-sessions.sql`.
3. Install dependencies:

   ```bash
   cd backend
   npm install
   ```

## Run

```bash
cd backend
npm start
```

The site is at http://localhost:3000 (or the `PORT` you set).

## Logins

There are two logins, each with its own password:

| Page | Who | Password | After login | Can open |
|------|-----|----------|-------------|----------|
| `/kitchen/login` | Kitchen staff | `STAFF_PASSWORD` | `/admin/kitchen` | The kitchen board and its APIs only (live orders, status changes, cancel) |
| `/owner/login` | The owner | `OWNER_PASSWORD` | `/admin/dashboard` | Everything: dashboard, menu photos, analytics, conversations, CSV export, and the kitchen |

- The old `/staff` address now redirects to `/kitchen/login`.
- If kitchen staff open an owner page, they're sent to `/owner/login` and owner APIs answer 403.
- If `OWNER_PASSWORD` is not set, owner login is off and says "Owner login is not configured". It
  never falls back to the staff password.
- Sessions are signed, httpOnly, Secure, SameSite=Lax cookies that slide: every successful request
  extends them. Kitchen: 24 hours after the last request, never more than 7 days after login (the
  board polls every 10 seconds, so it stays logged in while open). Owner: 7 days after the last
  visit, never more than 30 days after login. Changing a password signs everyone with that role
  out. Both pages have a **Log out** button.
- If the kitchen board's login ends, it covers the screen with "Session ended - log in again" and
  keeps pinging every 30 seconds; sound, mute and the chosen column are kept for after logging in.
- After 5 wrong passwords from one IP (or 50 from all IPs together), that login locks for 15 minutes.

## Test

```bash
cd backend
npm test
```

## Environment variables

| Name | Required | Notes |
|------|----------|-------|
| `ANTHROPIC_API_KEY` | Yes | Powers the AI Order Taker chat (Claude). |
| `GEMINI_API_KEY` | No | No longer used; kept until Stage 13. |
| `SUPABASE_URL` | Yes | Your Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Secret. Server only, never sent to the browser. |
| `STAFF_PASSWORD` | Yes | Kitchen login (`/kitchen/login`). Use a long, unique one. |
| `OWNER_PASSWORD` | Yes | Owner login (`/owner/login`). Must be different from `STAFF_PASSWORD`. Owner login is off while it's empty. |
| `PORT` | No | Defaults to 3000. |
| `CHAT_MODEL` | No | Defaults to `claude-haiku-5-5`. |

On a host, set these in its environment settings instead of uploading a `.env` file.

## Deploy to Vercel

Import the repository with the Root Directory left as `./`. `vercel.json` sets the build:
it copies `frontend/` to `public/`, which Vercel serves from its CDN, and the Express app runs as
one function loaded from the root `server.js`. Add the environment variables above under
**Settings → Environment Variables**.

With Supabase configured, chats and rate limits are kept in the tables from
`supabase/chat-sessions.sql`, because a customer's messages can reach different copies of the
server. Run that file before the first deploy, or every chat message will fail.

The root `package.json` installs the dependencies on Vercel. When you add or upgrade a
dependency in `backend/package.json`, make the same change there.
