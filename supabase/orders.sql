-- Doner Bros orders table. Run once in Supabase: Dashboard > SQL Editor > New query.
-- Prices are integer paisa (100 paisa = Rs 1), worked out by the backend from data/menu.json.

create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     bigint generated always as identity unique,
  -- The ID the customer is given, e.g. DB-20261030-K7M2QX: restaurant date plus 6 random characters.
  order_id         text not null unique check (order_id ~ '^DB-[0-9]{8}-[A-HJ-NP-Z2-9]{6}$'),
  -- Hash of the chat session and the reviewed order. Unique, so the same confirmed order can't
  -- be inserted twice (a double click or a retry gets the existing order back instead).
  submission_key   text not null unique check (submission_key ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  -- Every order starts as NEW; staff move it on from the dashboard, one step at a time.
  status           text not null default 'NEW' check (status in ('NEW', 'PREPARING', 'READY', 'COMPLETED')),
  order_type       text not null check (order_type in ('pickup', 'delivery')),
  customer_name    text not null check (char_length(customer_name) between 1 and 100),
  customer_phone   text not null check (char_length(customer_phone) between 7 and 20),
  delivery_address text check (char_length(delivery_address) <= 300),
  delivery_unit    text check (char_length(delivery_unit) <= 50),
  delivery_instructions text check (char_length(delivery_instructions) <= 300),
  -- Requested pickup time "HH:MM" (restaurant time); null means as soon as possible.
  pickup_time      text check (pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- Each line: { itemId, name, quantity, options: [{ name, choice }], unitPricePaisa, lineTotalPaisa }
  items            jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  subtotal_paisa   integer not null check (subtotal_paisa >= 0),
  discount_paisa   integer not null default 0 check (discount_paisa >= 0),
  tax_paisa        integer not null default 0 check (tax_paisa >= 0),
  -- null on a delivery order means the fee wasn't set, so it isn't in the total yet.
  delivery_fee_paisa integer check (delivery_fee_paisa >= 0),
  total_paisa      integer not null check (total_paisa >= 0),
  promotion_id     text,
  constraint delivery_needs_address
    check (order_type <> 'delivery' or delivery_address is not null),
  constraint total_matches
    check (total_paisa = subtotal_paisa - discount_paisa + tax_paisa + coalesce(delivery_fee_paisa, 0)),
  constraint delivery_details_only_for_delivery
    check (order_type = 'delivery' or (delivery_unit is null and delivery_instructions is null)),
  constraint pickup_time_only_for_pickup
    check (order_type = 'pickup' or pickup_time is null)
);

-- Row Level Security on, with no policies: the public anon key and signed-in users can't
-- read or write orders at all. Only the backend's service role key (which bypasses RLS)
-- can insert them.
alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;
-- Newer Supabase projects don't grant new tables to service_role automatically. The backend only
-- inserts orders and reads back their order ID (also to find an existing order on a duplicate).
grant select, insert on public.orders to service_role;
-- The staff dashboard (through the backend) may change an order's status, and nothing else.
grant update (status) on public.orders to service_role;
