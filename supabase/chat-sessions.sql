-- Doner Bros chat sessions and rate limits. Run once in Supabase: Dashboard > SQL Editor > New query.
-- On Vercel each message can reach a different copy of the server, so a chat's order state and the
-- rate limits live here instead of in the server's memory.

-- One row per chat: the cart, checkout details and confirmation progress (order-session.js).
-- id is a SHA-256 hash of the session cookie, so a leaked row can't be used as a cookie.
-- Rows idle for more than 2 hours are deleted by the server, along with the customer details in them.
create table if not exists public.chat_sessions (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  state      jsonb not null check (jsonb_typeof(state) = 'object'),
  last_seen  timestamptz not null default now()
);
create index if not exists chat_sessions_last_seen on public.chat_sessions (last_seen);

-- One row per counted event (a chat message, a wrong staff password). key is a purpose plus a
-- hash of the visitor's IP, e.g. "chat:3f2a...", so raw IP addresses aren't stored.
create table if not exists public.rate_limit_hits (
  key  text not null check (char_length(key) between 1 and 100),
  at   timestamptz not null default now()
);
create index if not exists rate_limit_hits_key_at on public.rate_limit_hits (key, at);
create index if not exists rate_limit_hits_at on public.rate_limit_hits (at);

-- Counts the key's events in the last p_window_seconds, after recording one if p_record is true,
-- in a single call. Older events for the key, and anyone's events over a day old, are deleted on the way.
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_record boolean)
returns integer
language plpgsql
set search_path = public
as $$
declare
  hits integer;
begin
  delete from public.rate_limit_hits where key = p_key and at < now() - make_interval(secs => p_window_seconds);
  delete from public.rate_limit_hits where at < now() - interval '1 day';
  if p_record then
    insert into public.rate_limit_hits (key) values (p_key);
  end if;
  select count(*) into hits from public.rate_limit_hits where key = p_key;
  return hits;
end;
$$;

-- Row Level Security on, with no policies: only the backend's service role key can use these.
alter table public.chat_sessions enable row level security;
alter table public.rate_limit_hits enable row level security;
revoke all on public.chat_sessions, public.rate_limit_hits from anon, authenticated;
grant select, insert, update, delete on public.chat_sessions, public.rate_limit_hits to service_role;
-- Functions can be called by everyone unless revoked.
revoke all on function public.rate_limit_hit(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, boolean) to service_role;
