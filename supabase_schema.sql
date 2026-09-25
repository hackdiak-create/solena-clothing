-- SOLENA CLOTHING — Supabase PostgreSQL + Storage
create extension if not exists pgcrypto;

create table if not exists public.products (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_content (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  order_number text unique,
  ref_command text unique,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'en attente',
  payment_method text,
  payment_status text default 'pending',
  total_amount numeric(12,2) default 0,
  currency text not null default 'XOF',
  customer jsonb default '{}'::jsonb,
  paytech_token text,
  paytech_payment_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_products_updated_at on public.products(updated_at);
create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_orders_ref_command on public.orders(ref_command);

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

alter table public.products enable row level security;
alter table public.site_content enable row level security;
alter table public.orders enable row level security;

drop policy if exists "Public can read products" on public.products;
create policy "Public can read products" on public.products
for select to anon, authenticated using (true);

drop policy if exists "Public can read site content" on public.site_content;
create policy "Public can read site content" on public.site_content
for select to anon, authenticated using (true);

-- Les commandes restent privées et sont manipulées par le backend avec
-- SUPABASE_SERVICE_ROLE_KEY. Cette clé ne doit jamais être exposée au navigateur.

-- Storage : lecture publique pour l'affichage, écriture réservée au service_role.
drop policy if exists "Public can read product images" on storage.objects;
create policy "Public can read product images" on storage.objects
for select to anon, authenticated using (bucket_id = 'product-images');

drop policy if exists "Backend can upload product images" on storage.objects;
create policy "Backend can upload product images" on storage.objects
for insert to service_role with check (bucket_id = 'product-images');

drop policy if exists "Backend can update product images" on storage.objects;
create policy "Backend can update product images" on storage.objects
for update to service_role using (bucket_id = 'product-images') with check (bucket_id = 'product-images');

drop policy if exists "Backend can delete product images" on storage.objects;
create policy "Backend can delete product images" on storage.objects
for delete to service_role using (bucket_id = 'product-images');
