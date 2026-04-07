create unique index if not exists listing_drafts_user_item_platform
  on public.listing_drafts (user_id, inventory_item_id, platform);
