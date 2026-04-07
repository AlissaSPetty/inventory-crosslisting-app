-- Track async AI draft generation (Listing drafts → Add new draft).
alter table public.inventory_items
add column if not exists draft_ai_status text
check (draft_ai_status is null or draft_ai_status in ('pending', 'failed'));

comment on column public.inventory_items.draft_ai_status is
  'pending: AI draft generation running; failed: last async run failed; null: idle or succeeded';
