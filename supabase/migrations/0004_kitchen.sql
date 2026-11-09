-- Stage 12: kitchen order board. Safe to run more than once.
-- Run in Supabase: Dashboard > SQL Editor > New query. Needs 0002_dashboard.sql first.

-- When an order entered each status. Set by the trigger below, never by the app, so every route
-- that changes a status records it the same way. Moving an order back to New clears its
-- preparation start; moving it back from Ready to Preparing (a mistaken tap) keeps the start
-- and clears only ready_at, so its preparation time still counts from when work began.
alter table public.orders add column if not exists status_changed_at timestamptz;
alter table public.orders add column if not exists preparing_at      timestamptz;
alter table public.orders add column if not exists ready_at          timestamptz;
alter table public.orders add column if not exists completed_at      timestamptz;
alter table public.orders add column if not exists cancelled_at      timestamptz;
update public.orders set status_changed_at = created_at where status_changed_at is null;
alter table public.orders alter column status_changed_at set default now();
alter table public.orders alter column status_changed_at set not null;

create index if not exists orders_status on public.orders (status);

-- Every status change, in order, for an audit trail.
create table if not exists public.order_status_changes (
  id          bigint generated always as identity primary key,
  order_id    text not null references public.orders (order_id) on delete cascade,
  from_status text not null,
  to_status   text not null,
  changed_at  timestamptz not null default now()
);
create index if not exists order_status_changes_order on public.order_status_changes (order_id, changed_at);

create or replace function public.stamp_order_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    case new.status
      when 'NEW'       then new.preparing_at := null; new.ready_at := null;
      when 'PREPARING' then
        if old.status = 'NEW' or new.preparing_at is null then new.preparing_at := now(); end if;
        new.ready_at := null;
      when 'READY'     then new.ready_at := now();
      when 'COMPLETED' then new.completed_at := now();
      when 'CANCELLED' then new.cancelled_at := now();
      else null;
    end case;
    insert into public.order_status_changes (order_id, from_status, to_status)
    values (new.order_id, old.status, new.status);
  end if;
  return new;
end $$;

drop trigger if exists orders_stamp_status on public.orders;
create trigger orders_stamp_status
  before update of status on public.orders
  for each row execute function public.stamp_order_status();

alter table public.order_status_changes enable row level security;
revoke all on public.order_status_changes from anon, authenticated;
grant select, insert on public.order_status_changes to service_role;

-- Minutes a card may sit in one kitchen column before it turns amber, then red.
-- DO NOTHING so a re-run never resets a value the owner has changed.
insert into public.menu_settings (key, value)
values
  ('kitchen_amber_minutes', '10'),
  ('kitchen_red_minutes', '20')
on conflict (key) do nothing;
