-- Acknowledgement for user-facing sync tasks (e.g. `manual_action_required` for hybrid Poshmark/Mercari).
-- `acknowledged_at is null` = open task; set when the seller marks the manual action done.
alter table public.sync_events
  add column if not exists acknowledged_at timestamptz;

comment on column public.sync_events.acknowledged_at is
  'When the user acknowledged a manual task (e.g. manual_action_required). Null = still open.';

-- Users may acknowledge (update) their own events. Inserts still come from the service role in workers.
create policy sync_events_update on public.sync_events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Fast lookup of open tasks per user/type.
create index if not exists sync_events_open_tasks_idx
  on public.sync_events (user_id, event_type)
  where acknowledged_at is null;
