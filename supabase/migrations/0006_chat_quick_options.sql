-- Which menu categories get a quick-option chip in the chat widget, as category slugs separated by
-- commas, in the order they are shown. Empty (or missing) shows a chip for every category.
-- Unknown or inactive slugs are skipped. Editable by staff in Supabase; no code change needed.
-- DO NOTHING so a re-run never overwrites a list that has since been changed.
insert into public.menu_settings (key, value)
values
  ('chat_quick_categories', 'doner-wraps,bros-special,doner-kebab,drinks')
on conflict (key) do nothing;
