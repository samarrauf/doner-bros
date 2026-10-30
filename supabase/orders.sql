-- Doner Bros orders table. Run once in Supabase: Dashboard > SQL Editor > New query.
-- Prices are integer paisa (100 paisa = Rs 1), worked out by the backend from data/menu.json.

create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     bigint generated always as identity unique,
  created_at       timestamptz not null default now(),
  status           text not null default 'new',
  order_type       text not null check (order_type in ('pickup', 'delivery')),
  customer_name    text not null check (char_length(customer_name) between 1 and 100),
  customer_phone   text not null check (char_length(customer_phone) between 7 and 20),
  delivery_address text check (char_length(delivery_address) <= 300),
  -- Each line: { itemId, name, quantity, options: [{ name, choice }], unitPricePaisa, lineTotalPaisa }
  items            jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  subtotal_paisa   integer not null check (subtotal_paisa >= 0),
  discount_paisa   integer not null default 0 check (discount_paisa >= 0),
  total_paisa      integer not null check (total_paisa >= 0),
  promotion_id     text,
  constraint delivery_needs_address
    check (order_type <> 'delivery' or delivery_address is not null),
  constraint total_matches
    check (total_paisa = subtotal_paisa - discount_paisa)
);

-- Row Level Security on, with no policies: the public anon key and signed-in users can't
-- read or write orders at all. Only the backend's service role key (which bypasses RLS)
-- can insert them.
alter table public.orders enable row level security;
revoke all on public.orders from anon, authenticated;
