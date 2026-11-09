-- Stage 2: menu schema. Safe to re-run.

-- Tables ---------------------------------------------------------------------

create table if not exists public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

create table if not exists public.menu_items (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references public.menu_categories(id) on delete restrict,
  slug          text unique not null,
  name          text not null,
  description   text,
  price_paisa   int not null check (price_paisa > 0),
  sort_order    int not null default 0,
  is_available  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.menu_deals (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  name         text not null,
  price_paisa  int not null check (price_paisa > 0),
  sort_order   int not null default 0,
  is_active    boolean not null default true
);

create table if not exists public.menu_deal_items (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references public.menu_deals(id) on delete cascade,
  label       text not null,
  item_id     uuid references public.menu_items(id),
  quantity    int not null default 1,
  sort_order  int not null default 0
);

create table if not exists public.menu_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- updated_at trigger on menu_items ---------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

-- Indexes ----------------------------------------------------------------------

create index if not exists menu_items_category_id_idx on public.menu_items (category_id);
create index if not exists menu_items_is_available_idx on public.menu_items (is_available);
create index if not exists menu_deal_items_deal_id_idx on public.menu_deal_items (deal_id);

-- Row level security -----------------------------------------------------------
-- No write policies exist, so only the service role (which bypasses RLS) can write.

alter table public.menu_categories enable row level security;
alter table public.menu_items      enable row level security;
alter table public.menu_deals      enable row level security;
alter table public.menu_deal_items enable row level security;
alter table public.menu_settings   enable row level security;

drop policy if exists "anon reads active categories" on public.menu_categories;
create policy "anon reads active categories"
  on public.menu_categories for select to anon
  using (is_active = true);

drop policy if exists "anon reads available items" on public.menu_items;
create policy "anon reads available items"
  on public.menu_items for select to anon
  using (is_available = true);

drop policy if exists "anon reads active deals" on public.menu_deals;
create policy "anon reads active deals"
  on public.menu_deals for select to anon
  using (is_active = true);

-- menu_deal_items has no active flag of its own: it follows its parent deal.
drop policy if exists "anon reads items of active deals" on public.menu_deal_items;
create policy "anon reads items of active deals"
  on public.menu_deal_items for select to anon
  using (
    exists (
      select 1 from public.menu_deals d
      where d.id = deal_id and d.is_active = true
    )
  );

-- menu_settings has no active flag, so it gets no anon policy: service role only.

-- Grants -----------------------------------------------------------------------
-- RLS only filters what a role's grants allow, so both layers must be set.

revoke all on public.menu_categories, public.menu_items, public.menu_deals,
              public.menu_deal_items, public.menu_settings
  from anon, authenticated;

grant select on public.menu_categories, public.menu_items, public.menu_deals,
                public.menu_deal_items
  to anon;

grant select, insert, update, delete
  on public.menu_categories, public.menu_items, public.menu_deals,
     public.menu_deal_items, public.menu_settings
  to service_role;
