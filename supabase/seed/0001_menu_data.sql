-- Stage 3: real Doner Bros menu. Safe to re-run.
-- Prices are written as rupees * 100 and stored as integer paisa.
-- This is the one dedicated seed file allowed to contain menu data.

begin;

-- Categories -------------------------------------------------------------------

insert into public.menu_categories (slug, name, sort_order)
values
  ('shawarma',      'Shawarma',        1),
  ('paratha',       'Paratha',         2),
  ('wraps',         'Wraps',           3),
  ('doner-wraps',   'Doner Wraps',     4),
  ('doner-kebab',   'Doner Kebab',     5),
  ('bros-special',  'Bros Special',    6),
  ('platters',      'Platters',        7),
  ('boxes',         'Boxes',           8),
  ('burgers',       'Burgers',         9),
  ('nuggets-wings', 'Nuggets & Wings', 10),
  ('pasta-rolls',   'Pasta & Rolls',   11),
  ('fries',         'Fries',           12),
  ('drinks',        'Drinks',          13)
on conflict (slug) do update
  set name = excluded.name,
      sort_order = excluded.sort_order;

-- Items ------------------------------------------------------------------------

insert into public.menu_items (category_id, slug, name, price_paisa, sort_order)
select c.id, v.slug, v.name, v.price_paisa, v.sort_order
from (
  values
    ('shawarma', 'chicken-shawarma', 'Chicken Shawarma', 290 * 100, 1),
    ('shawarma', 'zinger-shawarma',  'Zinger Shawarma',  330 * 100, 2),
    ('shawarma', 'grill-shawarma',   'Grill Shawarma',   390 * 100, 3),

    ('paratha', 'zinger-paratha',         'Zinger Paratha',         390 * 100, 1),
    ('paratha', 'chicken-cheese-paratha', 'Chicken Cheese Paratha', 450 * 100, 2),
    ('paratha', 'grill-paratha',          'Grill Paratha',          450 * 100, 3),

    ('wraps', 'chipotle-chicken-wrap', 'Chipotle Chicken Wrap', 390 * 100, 1),
    ('wraps', 'regular-zinger-wrap',   'Regular Zinger Wrap',   370 * 100, 2),
    ('wraps', 'grill-wrap',            'Grill Wrap',            450 * 100, 3),

    ('doner-wraps', 'doner-wrap',        'Doner Wrap',        850 * 100, 1),
    ('doner-wraps', 'arabic-wrap',       'Arabic Wrap',       900 * 100, 2),
    ('doner-wraps', 'bros-special-wrap', 'Bros Special Wrap', 990 * 100, 3),
    ('doner-wraps', 'flafel-wrap',       'Flafel Wrap',       650 * 100, 4),
    ('doner-wraps', 'twister-wrap',      'Twister Wrap',      650 * 100, 5),

    ('doner-kebab', 'flafel-doner',             'Flafel Doner',             650 * 100,  1),
    ('doner-kebab', 'german-doner-kebab',       'German Doner Kebab',       850 * 100,  2),
    ('doner-kebab', 'german-doner-with-fries',  'German Doner with Fries',  920 * 100,  3),
    ('doner-kebab', 'german-doner-with-cheese', 'German Doner with Cheese', 920 * 100,  4),
    ('doner-kebab', 'hummus-doner',             'Hummus Doner',             990 * 100,  5),
    ('doner-kebab', 'chicken-meat-pie',         'Chicken Meat Pie',         1700 * 100, 6),

    ('bros-special', 'chicken-quesadilla',  'Chicken Quesadilla',  650 * 100,  1),
    ('bros-special', 'german-chicken-nado', 'German Chicken Nado', 650 * 100,  2),
    ('bros-special', 'dutch-kapsalon',      'Dutch Kapsalon',      650 * 100,  3),
    ('bros-special', 'turkish-pide',        'Turkish Pide',        950 * 100,  4),
    ('bros-special', 'turkish-calzone',     'Turkish Calzone',     950 * 100,  5),
    ('bros-special', 'turkish-lahmacun',    'Turkish Lahmacun',    1400 * 100, 6),

    ('platters', 'german-platter-fries', 'German Platter (Fries)', 1150 * 100, 1),
    ('platters', 'german-platter-rice',  'German Platter (Rice)',  1150 * 100, 2),
    ('platters', 'german-mix-platter',   'German Mix Platter',     1250 * 100, 3),
    ('platters', 'german-fish-platter',  'German Fish Platter',    1400 * 100, 4),

    ('boxes', 'doner-gym-box',                'Doner Gym Box',                 650 * 100, 1),
    ('boxes', 'doner-box-with-fries',         'Doner Box with Fries',          650 * 100, 2),
    ('boxes', 'doner-box-with-fries-salad',   'Doner Box with Fries & Salad',  700 * 100, 3),
    ('boxes', 'doner-box-with-fries-cheese',  'Doner Box with Fries & Cheese', 700 * 100, 4),

    ('burgers', 'zinger-cheese-burger', 'Zinger Cheese Burger', 390 * 100, 1),
    ('burgers', 'zinger-burger',        'Zinger Burger',        350 * 100, 2),
    ('burgers', 'chicken-patty-burger', 'Chicken Patty Burger', 280 * 100, 3),

    ('nuggets-wings', 'nuggets-5-pcs',             'Nuggets (5 pcs)',           350 * 100, 1),
    ('nuggets-wings', 'nuggets-10-pcs',            'Nuggets (10 pcs)',          650 * 100, 2),
    ('nuggets-wings', 'hot-wings-5-pcs',           'Hot Wings (5 pcs)',         390 * 100, 3),
    ('nuggets-wings', 'hot-wings-10-pcs',          'Hot Wings (10 pcs)',        750 * 100, 4),
    ('nuggets-wings', 'oven-baked-wings-10-pcs',   'Oven Baked Wings (10 pcs)', 790 * 100, 5),
    ('nuggets-wings', 'tangy-wings-8-pcs',         'Tangy Wings (8 pcs)',       690 * 100, 6),
    ('nuggets-wings', 'buffalo-wings-8-pcs',       'Buffalo Wings (8 pcs)',     690 * 100, 7),
    ('nuggets-wings', 'cheetos-strips-4-pcs',      'Cheetos Strips (4 pcs)',    750 * 100, 8),

    ('pasta-rolls', 'regular-pasta',              'Regular Pasta',                  490 * 100, 1),
    ('pasta-rolls', 'large-pasta',                'Large Pasta',                    750 * 100, 2),
    ('pasta-rolls', 'special-calzone',            'Special Calzone',                790 * 100, 3),
    ('pasta-rolls', 'spinrolls-tikka-malai-boti', 'Spinrolls (Tikka / Malai Boti)', 590 * 100, 4),

    ('fries', 'plain-fries',  'Plain Fries',  290 * 100, 1),
    ('fries', 'masala-fries', 'Masala Fries', 350 * 100, 2),
    ('fries', 'loaded-fries', 'Loaded Fries', 590 * 100, 3),
    ('fries', 'pizza-fries',  'Pizza Fries',  650 * 100, 4),

    ('drinks', 'soft-drink-330ml',    'Soft Drink 330ml',     90 * 100,  1),
    ('drinks', 'soft-drink-500ml',    'Soft Drink 500ml',     90 * 100,  2),
    ('drinks', 'soft-drink-1-litre',  'Soft Drink 1 Litre',   180 * 100, 3),
    ('drinks', 'soft-drink-1-5-litre','Soft Drink 1.5 Litre', 240 * 100, 4),
    ('drinks', 'water-500ml',         'Water 500ml',          90 * 100,  5),
    ('drinks', 'water-1-5-litre',     'Water 1.5 Litre',      150 * 100, 6)
) as v (category_slug, slug, name, price_paisa, sort_order)
join public.menu_categories c on c.slug = v.category_slug
on conflict (slug) do update
  set category_id = excluded.category_id,
      name = excluded.name,
      price_paisa = excluded.price_paisa,
      sort_order = excluded.sort_order;

-- Deals ------------------------------------------------------------------------

insert into public.menu_deals (slug, name, price_paisa, sort_order)
values
  ('deal-1', 'Deal 1', 1900 * 100, 1),
  ('deal-2', 'Deal 2', 1150 * 100, 2),
  ('deal-3', 'Deal 3', 1200 * 100, 3)
on conflict (slug) do update
  set name = excluded.name,
      price_paisa = excluded.price_paisa,
      sort_order = excluded.sort_order;

-- Deal contents ----------------------------------------------------------------
-- menu_deal_items has no slug or unique key, so ON CONFLICT cannot apply here.
-- Re-runs stay safe by replacing the rows of these deals.
-- item_slug is NULL where a label does not clearly match exactly one menu item.

delete from public.menu_deal_items
where deal_id in (
  select id from public.menu_deals where slug in ('deal-1', 'deal-2', 'deal-3')
);

insert into public.menu_deal_items (deal_id, label, item_id, quantity, sort_order)
select d.id, v.label, i.id, v.quantity, v.sort_order
from (
  values
    ('deal-1', '5 Zinger Burgers', 'zinger-burger',    5, 1),
    ('deal-1', '1.5 Litre Drink',  null,               1, 2),

    ('deal-2', '1 Zinger Burger',    'zinger-burger',      1, 1),
    ('deal-2', '1 Chicken Shawarma', 'chicken-shawarma',   1, 2),
    ('deal-2', '1 Chicken Wrap',     null,                 1, 3),
    ('deal-2', '1 Litre Drink',      'soft-drink-1-litre', 1, 4),

    ('deal-3', '1 Special Calzone', 'special-calzone', 1, 1),
    ('deal-3', '1 Fries',           null,              1, 2),
    ('deal-3', '1 Dip Sauce',       null,              1, 3),
    ('deal-3', '500ml Drink',       null,              1, 4)
) as v (deal_slug, label, item_slug, quantity, sort_order)
join public.menu_deals d on d.slug = v.deal_slug
left join public.menu_items i on i.slug = v.item_slug;

-- Settings ---------------------------------------------------------------------

insert into public.menu_settings (key, value)
values
  -- Provisional until the restaurant confirms tax.
  ('tax_mode',           'none'),
  ('tax_rate_bps',       '0'),
  ('delivery_fee_paisa', '0'),
  ('currency',           'PKR'),
  ('order_types',        'pickup,delivery'),
  ('whatsapp',           '03103994111'),
  ('address',            'Food Court, Shalimar Smart City, in front of Shinwari Khas, Sargodha')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

commit;
