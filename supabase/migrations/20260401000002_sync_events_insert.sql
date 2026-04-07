create policy sync_events_insert on public.sync_events
  for insert
  with check (auth.uid() = user_id);
