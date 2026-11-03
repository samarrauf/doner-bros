# Doner Bros

Web app for the Doner Bros doner kebab restaurant: menu, AI Order Taker chat, and a staff
dashboard for orders. Orders are saved to Supabase.

## Structure

```
frontend/   customer-facing site (index.html, styles.css, app.js)
admin/      staff dashboard, served at /staff
backend/    Express server and API code
data/       menu, pricing, promotions and restaurant details
prompts/    AI Order Taker system prompt
supabase/   SQL for the orders table
CLAUDE.md   guidance for Claude
```

## Requirements

- Node.js 18 or newer
- A Supabase project with the `orders` table from `supabase/orders.sql`
- A Gemini API key for the AI Order Taker

## Setup

1. Copy `.env.example` to `.env` in the project root and fill in the values. Never commit `.env`.
2. Install dependencies:

   ```bash
   cd backend
   npm install
   ```

## Run

```bash
cd backend
npm start
```

The site is at http://localhost:3000 (or the `PORT` you set) and the staff dashboard is at `/staff`.

## Test

```bash
cd backend
npm test
```

## Environment variables

| Name | Required | Notes |
|------|----------|-------|
| `GEMINI_API_KEY` | Yes | Powers the AI Order Taker chat. |
| `SUPABASE_URL` | Yes | Your Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Secret. Server only, never sent to the browser. |
| `STAFF_PASSWORD` | Yes | Password for `/staff`. Use a long, unique one. |
| `PORT` | No | Defaults to 3000. |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.5-flash`. |

On a host, set these in its environment settings instead of uploading a `.env` file.
