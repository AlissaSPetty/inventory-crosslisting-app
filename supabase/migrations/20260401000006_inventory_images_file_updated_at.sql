-- When the same storage_path is overwritten (crop/rotate), browsers cache the public URL.
-- Bump this timestamp on replace so clients can append ?v=... to bust cache.
alter table public.inventory_images
  add column file_updated_at timestamptz;

update public.inventory_images
  set file_updated_at = created_at
  where file_updated_at is null;

alter table public.inventory_images
  alter column file_updated_at set not null,
  alter column file_updated_at set default now();
