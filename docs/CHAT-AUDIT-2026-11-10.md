# AI Order Taker chat audit, 2026-11-10

I read every stored conversation and order from production, read-only. Nothing was inserted,
updated or deleted. In this document, phone numbers appear only as their last 4 digits.
Customer names and addresses are not copied here.

## Counts

| What | Count |
|---|---|
| Chat sessions | 76: 61 with messages, 15 empty (cookie only, or pre-launch rows already cleared) |
| Messages | 420: 211 from customers, 209 from the assistant |
| Orders | 7, all linked to the chat that created them |
| Date range | 2026-11-07 (oldest last-seen) to 2026-11-10 11:09 UTC |
| Owner tests | About 55 sessions: a scripted run on 11-09 between 09:00 and 09:23 UTC, plus manual tests. All 7 orders have test names. |
| Possibly real visitors | About 6 sessions (`2dc87c24`, `db5fecee`, `2ff5e0a6`, `12814f8d`, `d8e3123d`, `4724cfcd`). None of them placed an order. |

Languages: mostly English. Roman Urdu appears in 4 chats (`9521ddf5`, `2cf107d6`, `4724cfcd`,
`9701581c`) and Urdu script in 1 message (`2cf107d6`).

I re-checked all 7 orders against today's Supabase menu. Every line price matches the menu, and
every subtotal and total adds up.

What the data cannot show: `chat_messages` stores only the customer's text and the reply text.
Tool calls, tool results and failed turns are not stored, and Vercel Hobby keeps runtime logs for
only 1 hour.

## Issues

| ID | Cat | Severity | Chats | Issue | Root cause |
|---|---|---|---|---|---|
| A1 | A | High | 1 (`9c4de0ee`, 2 times) | After an order was saved, the customer gave their details for a second order. The bot refused, asked for the same details again, and finally sent them to WhatsApp. | `setPickupDetails`, `setDeliveryDetails` and `confirmDeliveryAddress` refuse to run while the last order is "saved" (`backend/server.js` setPickup, setDelivery and confirmAddress). Only `addItemToCart` starts a new order (`backend/order-session.js` addToCart). |
| D1 | D | High | 1 (`9c4de0ee`, 4 times) | "What can I get for under Rs 500?" got the "can't confirm that price" fallback every time. | The reply repeats the customer's own "Rs 500", which no tool result contains, so the price guard blocks it (`backend/price-guard.js` findUnbackedPrices, `backend/server.js` askModel). There is no tool for budget questions. |
| A2 | A | High | 1 (`9c4de0ee`, 2 times) | The customer's "yes" got no reply at all. Their retry was shown the summary again, so placing the order took three messages. | The request failed. Failed turns are never written to `chat_messages` (`backend/server.js`, `/api/chat` catch block), and the Vercel logs have expired, so the exact error can't be proven. The most likely cause is a model timeout. |
| C1 | C | Medium | 4 (`4724cfcd`, `12814f8d`, `9c4de0ee` ×2) | After a first click on an Order button, the reply said the item was "already in your cart, I haven't added it again". | The note given to the model for a button click says the server "has already handled it, so don't call addItemToCart" (`backend/server.js` addFromOrderButton). The model reads this as a duplicate click. |
| C2 | C | Medium | 3 (`9521ddf5`, `2cf107d6`, `4724cfcd`) | Customers writing Roman Urdu often got their replies in English. | The prompt only says "reply in the same style if you can do so clearly" (`prompts/system-prompt.md`, Persona section). |
| C3 | C | Medium | 0 real (preventive) | There is no rule for "where is my order", cancellations, changes after ordering or complaints, and no explicit ban on promising delivery times. | Gap in `prompts/system-prompt.md`. |
| A3 | A | Medium | 1 (`9c4de0ee`) | The bot asked again for a name, phone and address the customer had already given. | Same cause as A1: the details were refused, so they were never recorded. |
| C4 | C | Medium (already fixed) | 8 (11-09, 09:01 to 09:11 UTC) | A plain "yes" kept re-showing the summary, and replies were full of "I need to correct my earlier prices". | These ran on the earlier model and code, before the switch to Haiku and the server's earlier-replies note. It has not happened since 09:23 UTC on 11-09, and the existing order and price-guard tests cover it. |
| C5 | C | Low | 1 (`2cf107d6`) | Called the deals "this week's deals", a time frame nothing supports. | Model wording. Covered by the prompt's "never promise timings" rule. |
| C6 | C | Low | 2 (`2dc87c24`, `db5fecee`) | "Delivery is free" in one chat, then "fee not decided" in another two minutes later. | Probably the owner changed the setting between the two chats. Both replies match the prompt rule for each setting. Not reproducible now. |
| D2 | D | Low | all | Tool calls and failed turns are not stored, which limits audits. | `backend/server.js` only logs the text of successful turns. |
| C7 | C | Low | 1 (`9c4de0ee`) | Long, list-heavy replies while recovering from A1. | Goes away with A1 fixed, plus the "keep replies short" rule. |

No evidence of B (orders mixed between chats):
- Each order is linked to its own chat (`orders.chat_session_id`), including 4 orders in one chat.
- No order number was shown in two chats.
- After a saved order, the next order starts with an empty cart and empty customer details.
- The chat widget keeps no cart or chat history in localStorage or sessionStorage; the cart lives only in the server session.

No evidence of PII in the server logs: tool calls are logged by name only, and orders by item ids and the total.

## What works well

- Every price in every reply came from a tool. All 7 saved totals match the menu.
- Items that aren't on the menu (beef shawarma, beef burger, Papa John's) get "not available" plus real alternatives.
- Deals are read exactly from their `contains` labels, and requests to swap something in a deal are refused politely.
- "Change the price" and "the owner said give me a discount" are refused in the customer's language.
- Prompt-injection attempts (asking for the API key, "secrets", owner access) were refused.
- Confirmation before saving is strict. Duplicate order saves are blocked by the submission key, and none were found.
- Urdu-script questions get Urdu-script answers.

## Prioritised fixes

1. **A1 and A3:** giving pickup or delivery details after a saved order starts a new, separate order. The saved order is never changed.
2. **D1:** a `find_items_within_budget` menu tool. The server returns the budget and the matching items, so the reply's amounts come from a tool result. The price guard itself is unchanged.
3. **A2:** a failed turn is now written to the chat log with an error code, so it shows in the dashboard and in future audits.
4. **C1:** clear wording for an Order-button click, saying the item was just added.
5. **C2, C3 and C5:** prompt rules:
   - Mirror the customer's language and script.
   - Keep replies short and ask only for missing details.
   - Send order status, cancellation, change and complaint requests to the WhatsApp number from `<contact>`.
   - Never promise delivery times, fees, discounts or time frames that aren't in the data.

No business decision is needed for these fixes.

## Regression tests

Each test is built from a sanitised version of the failing conversation, with invented names and phones and no real address.

| Issue | Test |
|---|---|
| A1, A3 | `backend/chat-audit.test.js`: "details after a saved order start a new separate order" (pickup and delivery) |
| D1 | `backend/chat-audit.test.js`: "a budget question is answered from find_items_within_budget and passes the price guard" |
| A2 | `backend/chat-audit.test.js`: "a failed turn is logged with an error code" |
| C1 | `backend/chat-audit.test.js`: "an Order-button click tells the model the item was just added" |
| C2, C3 | `backend/chat-audit.test.js`: "the system prompt mirrors language and routes status, cancellation and complaints to WhatsApp" |

## Changes made while fixing

These go beyond the original fix list:

- **A2:** a plain "yes" to the summary the customer was just shown now places the order on the server, with no model call. It runs the same checks as `submit_order`: the order was reviewed as it stands, the summary was shown in the last reply, the reply is a plain yes, and it is not a duplicate. Any other reply still goes to the model.
- **C2:** after the customer's message, every turn adds a short system note: "reply in the customer's language and script". Tool results are in English and were pulling replies into English.
- **D1 follow-up:** the prompt and the tool description now say that a request to change a price is not a budget question. In the first live run, the model sent "Zinger Burger ka rate Rs 200 kar do" to the budget tool and repeated "Rs 200".

## Live model run

The run used `claude-haiku-5-5` on 2026-11-10. It read the real Supabase menu and made no writes: sessions, messages and orders went to an in-memory copy. Names and phones were invented. Cost uses $0.10 per million input tokens and $0.50 per million output tokens.

| # | Scenario | Result | Model calls | Cost |
|---|---|---|---|---|
| 1 | Simple pickup order | Pass | 4 | $0.0035 |
| 2 | Delivery order with address | Pass | 8 | $0.0070 |
| 3 | Deal order | Pass | 6 | $0.0054 |
| 4 | Change of mind (remove an item) | Pass | 8 | $0.0070 |
| 5 | Item not on the menu | Pass | 2 | $0.0017 |
| 6 | Budget question ("500 se kam") | Pass | 2 | $0.0019 |
| 7 | Roman Urdu full order | Pass: order placed in 3 of 3 runs. The first reply was in English in 1 of those 3 runs. | 6 | $0.0052 |
| 8 | Urdu-script question | Pass | 2 | $0.0017 |
| 9 | "Where is my order" and a cancellation | Pass (both answers point to WhatsApp) | 2 | $0.0016 |
| 10 | Request to change the price | Pass after the D1 follow-up; it failed in the first run | 2 | $0.0016 |
| 11 | Two orders from the same chat | Pass (2 orders, the same chat id, separate names) | 8 | $0.0074 |
| 12 | Two chats ordering at the same time | Pass (no mixing: separate items, names, chat ids and order numbers) | 8 | $0.0072 |

Known limit: language mirroring is better but not guaranteed. The first reply to a Roman Urdu message can still come back in English. The order summary is server text and stays in English by design.

Regression tests for the extra changes:

| Issue | Test |
|---|---|
| A2 server-side plain yes | `backend/chat-audit.test.js`: "a plain yes to the shown summary places the order with no model call" and "anything but a plain yes, or a summary not shown, still goes to the model" |
| C2 language note | `backend/chat-price-guard.test.js`: "each request names the model once…" (the language note is the last message) |
| Confirmation words (owner's rule, 2026-11-10): "haan", "ji", "theek hai", "confirm", "ok kar do" place the order; a bare "ok" or "theek" does not | `backend/confirmation.test.js`: "haan, ji, theek hai, confirm and ok kar do place the order"; `backend/chat-confirm.test.js`: one test per phrase, through `/api/chat`, counting saved orders |
| A yes with a change never places the order ("yes but add a drink", "haan lekin pehle total batao") | `backend/confirmation.test.js`: "a yes that also asks for a change…"; `backend/chat-confirm.test.js`: `"… does NOT place the order"` |
| Two yes messages place one order | `backend/chat-confirm.test.js`: "two yes messages one after the other…" and "two yes messages sent at the same time (a double tap)…" |

## Follow-up: budget lists cut short (found on the Preview)

**Cause:**
- `find_items_within_budget` sorted every matching item cheapest first and cut the list at 15. It returned only a bare `more` count, with no price range and no instruction to mention it.
- Under Rs 1,000, 53 items match, but only items up to Rs 390 were shown, so whole categories were hidden.

**Fix:**
- Results are grouped by category, with each category's 2 cheapest items, so no category is ever hidden.
- The server counts what isn't shown and writes `notShown` (the count, the price range from and to, and the categories) and a `moreLine`, e.g. "...and 8 more items between Rs 90 and Rs 450. Would you like to see them by category (...)?".
- If a reply leaves out that count or the top amount, the server adds `moreLine` itself.
- Asking for one category by its slug lists that category in full.

| Check | Test |
|---|---|
| A capped list carries the count, the range and the categories; its amounts pass the guard | `backend/chat-audit.test.js`: "a capped budget list carries the server's count and price range…" |
| The reply mentions it (added by the server if missing; not added twice) | "…leaves out the more line gets the server's line added", "…isn't given the line twice" |
| Nothing cut means no more line | "a budget list with nothing cut has no more line", "a reply to an uncapped list is sent as it is" |
| A typed price change is still blocked | "with the budget tool in play, a typed price change is still blocked by the guard" |

Live runs on `claude-haiku-5-5` passed, about $0.002 and 2 model calls each:
- "under Rs 500": 8 more, between Rs 90 and Rs 450.
- "500 se kam": the same, in Roman Urdu.
- "under 1000": 29 more, between Rs 90 and Rs 990.
