# Doner Bros — project rules

## Business
Doner Bros, Food Court, Shalimar Smart City, Sargodha. WhatsApp 0310-3994111.
Order types: pickup and delivery. Delivery fee is configurable, currently 0.

## Money
All prices are stored and calculated in PAISA as integers. Rs 290 = 29000.
Never use floats for money. Never round in the AI layer.
All totals are calculated in backend code, never by the AI model.

## Menu
Supabase is the ONLY source of truth for menu items, prices and deals.
No menu data may be hardcoded in any file, including tests, prompts and seed scripts
other than the one dedicated seed file.
If the menu is needed anywhere, read it through the backend menu service.

## AI agent rules
The agent must never state a price, item name or deal from memory.
Every menu answer must come from a tool call that reads Supabase.
If an item is not in the menu, the agent says it is not available and offers the
closest real alternative from the menu. It never invents items, sizes or prices.
The agent never computes a total; it calls the totals function.

## Working style
Do not read files you were not asked to read. Ask before widening scope.
Do not refactor anything that was not part of the task.
Keep responses short. No summaries of code you just wrote unless asked.

## Secrets
Supabase URL and service key come from environment variables only.
Never print key values. Never commit .env.
