-- Extensions
create extension if not exists "pgcrypto";

-- Organizations (nullable for MVP single-seller)
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Personal',
  created_at timestamptz not null default now()
);

-- Profiles linked to auth.users
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id),
  display_name text,
  created_at timestamptz not null default now()
);

-- Stripe billing
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade unique,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  plan_tier text not null default 'free',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);

-- Inventory
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id),
  sku text,
  title text not null,
  quantity_available integer not null default 0 check (quantity_available >= 0),
  status text not null default 'active' check (status in ('active', 'sold', 'archived')),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index inventory_items_user_id_idx on public.inventory_items (user_id);

-- Platform listings
create type public.platform_type as enum (
  'ebay',
  'shopify',
  'depop',
  'poshmark',
  'mercari'
);

create type public.listing_source_type as enum ('app', 'sync_fetch', 'manual_link');

create table public.platform_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid references public.inventory_items (id) on delete set null,
  platform public.platform_type not null,
  external_listing_id text,
  shop_domain text,
  listing_url text,
  status text not null default 'draft',
  listed_quantity integer not null default 1 check (listed_quantity >= 0),
  listed_at timestamptz,
  ends_at timestamptz,
  relist_at timestamptz,
  metadata jsonb not null default '{}',
  source public.listing_source_type not null default 'app',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index platform_listings_user_id_idx on public.platform_listings (user_id);
create index platform_listings_inventory_idx on public.platform_listings (inventory_item_id);
create unique index platform_listings_external_unique
  on public.platform_listings (user_id, platform, external_listing_id)
  where external_listing_id is not null;

-- Drafts
create table public.listing_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  platform public.platform_type not null,
  payload jsonb not null default '{}',
  version integer not null default 1,
  published_listing_id uuid references public.platform_listings (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index listing_drafts_user_idx on public.listing_drafts (user_id);

-- Encrypted credential blobs (app decrypts with server secret)
create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform public.platform_type not null,
  encrypted_payload text not null,
  shop_domain text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index integration_credentials_user_platform_shop
  on public.integration_credentials (user_id, platform, (coalesce(shop_domain, '')));

-- Sync / webhook audit
create table public.sync_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  inventory_item_id uuid references public.inventory_items (id) on delete set null,
  platform public.platform_type,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index sync_events_user_idx on public.sync_events (user_id);

-- Webhook idempotency
create table public.processed_webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);

-- Inventory images
create table public.inventory_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items (id) on delete cascade,
  storage_path text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- RLS
alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.inventory_items enable row level security;
alter table public.platform_listings enable row level security;
alter table public.listing_drafts enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.sync_events enable row level security;
alter table public.inventory_images enable row level security;
alter table public.organizations enable row level security;

-- Profiles: own row
create policy profiles_select on public.profiles for select using (auth.uid() = id);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id);

-- Customers / subscriptions: own rows
create policy customers_all on public.customers for all using (auth.uid() = user_id);
create policy subscriptions_all on public.subscriptions for all using (auth.uid() = user_id);

-- Inventory: own rows
create policy inventory_items_all on public.inventory_items for all using (auth.uid() = user_id);

-- Platform listings
create policy platform_listings_all on public.platform_listings for all using (auth.uid() = user_id);

-- Drafts
create policy listing_drafts_all on public.listing_drafts for all using (auth.uid() = user_id);

-- Credentials
create policy integration_credentials_all on public.integration_credentials for all using (auth.uid() = user_id);

-- Sync events (read own; inserts may come from service role in workers)
create policy sync_events_select on public.sync_events for select using (auth.uid() = user_id);

-- Images
create policy inventory_images_all on public.inventory_images for all using (auth.uid() = user_id);

-- Organizations: user can read org they belong to
create policy orgs_select on public.organizations for select
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.organization_id = organizations.id)
  );

-- Storage bucket for listing photos (public read with RLS on objects — configured in second migration)
-- Trigger: new user profile
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  insert into public.organizations (name) values ('Personal') returning id into org_id;
  insert into public.profiles (id, organization_id, display_name)
  values (new.id, org_id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into public.customers (user_id) values (new.id);
  insert into public.subscriptions (user_id, plan_tier, status) values (new.id, 'free', 'inactive');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger inventory_items_updated before update on public.inventory_items
  for each row execute function public.set_updated_at();
create trigger platform_listings_updated before update on public.platform_listings
  for each row execute function public.set_updated_at();
create trigger listing_drafts_updated before update on public.listing_drafts
  for each row execute function public.set_updated_at();
create trigger integration_credentials_updated before update on public.integration_credentials
  for each row execute function public.set_updated_at();
create trigger subscriptions_updated before update on public.subscriptions
  for each row execute function public.set_updated_at();
