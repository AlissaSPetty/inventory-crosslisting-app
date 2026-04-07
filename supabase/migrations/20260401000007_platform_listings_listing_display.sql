-- Marketplace display fields (sync + publish) for Active listings UI
alter table public.platform_listings
  add column if not exists listing_title text,
  add column if not exists listing_image_url text;

comment on column public.platform_listings.listing_title is 'Listing title on the marketplace (e.g. eBay product title).';
comment on column public.platform_listings.listing_image_url is 'HTTPS URL of the primary listing image on the marketplace.';
