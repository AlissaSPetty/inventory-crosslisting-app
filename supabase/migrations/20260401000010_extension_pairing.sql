-- Browser-extension pairing + device tokens.
--
-- Poshmark/Mercari have no public API, so a browser extension reads the user's
-- closet in their own logged-in session and pushes it to the API. The extension
-- authenticates with a long-lived device token, obtained by exchanging a
-- short-lived pairing code minted by the (already authenticated) web app.
--
-- Secrets are stored HASHED (sha256 hex). Token/code creation, hash lookup, and
-- "mark used" all run through the service role in the API; the web client only
-- ever lists/revokes its own devices via safe (hash-free) column projections.

-- Long-lived device tokens (one per paired extension install).
create table if not exists public.extension_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  label text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists extension_tokens_user_idx on public.extension_tokens (user_id);

-- Short-lived, single-use pairing codes (web app → extension handoff).
create table if not exists public.extension_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists extension_pairing_codes_user_idx on public.extension_pairing_codes (user_id);
create index if not exists extension_pairing_codes_expires_idx on public.extension_pairing_codes (expires_at);

alter table public.extension_tokens enable row level security;
alter table public.extension_pairing_codes enable row level security;

-- Device list + revoke: users read/delete their OWN tokens. Never SELECT
-- token_hash from the web path — API endpoints project safe columns only.
-- Inserts / hash lookups / mark-used are performed by the service role (bypasses RLS).
create policy extension_tokens_select on public.extension_tokens
  for select using (auth.uid() = user_id);
create policy extension_tokens_delete on public.extension_tokens
  for delete using (auth.uid() = user_id);

-- Pairing codes are service-role only (no user-facing policies): RLS enabled with
-- no policy blocks the authenticated/anon roles, while the service role bypasses it.
