import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (!url || !anon) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Add them to the repo root .env (Vite loads from there) or apps/web/.env — same values as SUPABASE_URL and SUPABASE_ANON_KEY, but the names must start with VITE_."
  );
}

export const supabase = createClient(url, anon);
