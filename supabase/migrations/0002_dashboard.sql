-- Stage 10: data behind the owner dashboard. Safe to run more than once.
-- Run in Supabase: Dashboard > SQL Editor > New query. Needs supabase/orders.sql and
-- supabase/chat-sessions.sql to have been run first.

-- Orders ---------------------------------------------------------------------------------------

create index if not exists orders_created_at on public.orders (created_at);
create index if not exists orders_order_type on public.orders (order_type);
create index if not exists orders_customer_phone on public.orders (customer_phone);

-- An order can now be CANCELLED. Cancelled orders are counted on their own and left out of sales.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'));

-- Chat sessions --------------------------------------------------------------------------------
-- Rows are no longer deleted after 2 hours idle: the customer details in state are cleared
-- instead, and the row (with its messages) is deleted after 30 days.

create index if not exists chat_sessions_last_seen on public.chat_sessions (last_seen);

alter table public.chat_sessions add column if not exists started_at timestamptz not null default now();
alter table public.chat_sessions add column if not exists ended_in_order boolean not null default false;
alter table public.chat_sessions add column if not exists order_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_sessions_order_id_fkey') then
    alter table public.chat_sessions
      add constraint chat_sessions_order_id_fkey
      foreign key (order_id) references public.orders (order_id) on delete set null;
  end if;
end $$;

create index if not exists chat_sessions_started_at on public.chat_sessions (started_at);

-- Chat messages: what the customer typed and what AI Order Taker replied. Kept 30 days.
create table if not exists public.chat_messages (
  id          bigint generated always as identity primary key,
  session_id  text not null references public.chat_sessions (id) on delete cascade,
  role        text not null check (role in ('customer', 'assistant')),
  content     text not null check (char_length(content) between 1 and 4000),
  created_at  timestamptz not null default now()
);
create index if not exists chat_messages_session_created on public.chat_messages (session_id, created_at);
create index if not exists chat_messages_created_at on public.chat_messages (created_at);

-- Every search_items call that found nothing, so the dashboard can show what customers ask for
-- that isn't on the menu. query is lower-cased and trimmed. Kept 30 days.
create table if not exists public.menu_search_misses (
  id          bigint generated always as identity primary key,
  query       text not null check (char_length(query) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists menu_search_misses_created_at on public.menu_search_misses (created_at);

-- Only the backend's service role key can use these.
alter table public.chat_messages enable row level security;
alter table public.menu_search_misses enable row level security;
revoke all on public.chat_messages, public.menu_search_misses from anon, authenticated;
grant select, insert, delete on public.chat_messages, public.menu_search_misses to service_role;
