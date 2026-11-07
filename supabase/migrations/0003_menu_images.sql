-- Stage 3b: image support for the menu. Safe to re-run.
-- A NULL image_url is valid: it means the restaurant has not uploaded a photo.

alter table public.menu_items      add column if not exists image_url text;
alter table public.menu_categories add column if not exists image_url text;

-- menu_settings.value is NOT NULL, so '' means "no image yet".
-- DO NOTHING so a re-run never wipes an image that has since been uploaded.
insert into public.menu_settings (key, value)
values
  ('hero_image_url', ''),
  ('brand_logo_url', '')
on conflict (key) do nothing;
