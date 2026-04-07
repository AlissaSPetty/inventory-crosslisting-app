import type { SupabaseClient } from "@supabase/supabase-js";

export async function getEntitlements(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("subscriptions")
    .select("plan_tier, status")
    .eq("user_id", userId)
    .maybeSingle();
  const tier = data?.plan_tier ?? "free";
  const active = data?.status === "active" || data?.status === "trialing";
  return { tier, active, canUseAi: active && tier !== "free" };
}
