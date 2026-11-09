-- Stage 12c: many orders per chat. Safe to run more than once.
-- Run in Supabase: Dashboard > SQL Editor > New query. Needs 0002_dashboard.sql first.
--
-- The link now lives on the order: each order names the chat it came from, so one chat can have
-- any number of orders. chat_sessions.order_id is kept as a legacy column (it only ever held the
-- latest order) and is no longer read.

alter table public.orders add column if not exists chat_session_id text;

-- Named, because chat_sessions.order_id already links the two tables the other way and the API
-- has to be told which link to follow.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_chat_session_id_fkey') then
    alter table public.orders
      add constraint orders_chat_session_id_fkey
      foreign key (chat_session_id) references public.chat_sessions (id) on delete set null;
  end if;
end $$;

create index if not exists orders_chat_session_id on public.orders (chat_session_id);

-- Backfill from the legacy link. Only fills orders that have no link yet.
update public.orders o
set chat_session_id = s.id
from public.chat_sessions s
where s.order_id = o.order_id
  and o.chat_session_id is null;

-- The backend sets the link in the same insert that saves the order, so it needs no update grant.
