import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI, type Part } from "@google/genai";
import { DRAFT_EDITOR_INITIAL_PHOTO_COUNT, PLATFORMS } from "@inv/shared";
import type { Env } from "../env.js";
import { fetchFirstCategorySuggestion } from "./ebayCategoryApi.js";

export const GENERATION_PENDING_PAYLOAD_KEY = "_generationPending";
export const GENERATION_FAILED_PAYLOAD_KEY = "_generationFailed";
export const GENERATION_ERROR_PAYLOAD_KEY = "_error";

export type AiDraftGenerationResult =
  | { ok: true; summary: string; drafts: Record<string, Record<string, unknown>> }
  | { ok: false; message: string };

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const buf = await res.arrayBuffer();
    const data = Buffer.from(buf).toString("base64");
    return { data, mimeType };
  } catch {
    return null;
  }
}

/**
 * Full Gemini + Taxonomy pipeline; replaces all `listing_drafts` for the item and clears `draft_ai_status`.
 */
export async function runAiDraftGenerationCore(
  env: Env,
  service: SupabaseClient,
  userId: string,
  inventoryItemId: string
): Promise<AiDraftGenerationResult> {
  const { data: item, error: itemErr } = await service
    .from("inventory_items")
    .select("id, title, sku, user_id")
    .eq("id", inventoryItemId)
    .single();
  if (itemErr || !item || item.user_id !== userId) {
    return { ok: false, message: "Item not found" };
  }

  if (!env.GEMINI_API_KEY) {
    return { ok: false, message: "GEMINI_API_KEY not configured" };
  }

  const { data: images, error: imgErr } = await service
    .from("inventory_images")
    .select("storage_path")
    .eq("inventory_item_id", item.id)
    .order("sort_order");
  if (imgErr) {
    return { ok: false, message: imgErr.message };
  }

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  const imageUrls =
    images?.map((im) => {
      const base = env.SUPABASE_URL.replace(/\/$/, "");
      return `${base}/storage/v1/object/public/listing-photos/${im.storage_path}`;
    }) ?? [];

  const imageParts: Part[] = [];
  for (const url of imageUrls.slice(0, DRAFT_EDITOR_INITIAL_PHOTO_COUNT)) {
    const img = await fetchImageAsBase64(url);
    if (img) {
      imageParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  const contentParts: Part[] =
    imageParts.length > 0
      ? [
          {
            text: "Describe this item for resale: brand, category, condition, colors, defects, measurements if visible.",
          },
          ...imageParts,
        ]
      : [{ text: `Generate listing copy for: ${item.title} (SKU ${item.sku ?? "n/a"})` }];

  const v = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: contentParts,
  });
  const summary = v.text ?? "";

  const drafts: Record<string, Record<string, unknown>> = {};
  for (const p of PLATFORMS) {
    const ebayExtra =
      p === "ebay"
        ? ` For eBay also include: category_id_hint (string, US site leaf category ID digits only if you can infer a plausible eBay category from the item; otherwise empty string), and price_hint_cents as a fair resale estimate in USD cents using typical sold prices across resale channels (eBay, Poshmark, Mercari patterns) — not a guarantee.`
        : "";
    const d = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Summary:\n${summary}\n\nOriginal title: ${item.title}`,
      config: {
        systemInstruction: `You output JSON only for a ${p} listing draft with keys: title, body, price_hint_cents, tags (array of strings).${ebayExtra}`,
        responseMimeType: "application/json",
      },
    });
    try {
      drafts[p] = JSON.parse(d.text ?? "{}") as Record<string, unknown>;
    } catch {
      drafts[p] = { title: item.title, body: summary };
    }
  }

  const ebayDraft = drafts.ebay;
  if (ebayDraft && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    try {
      const q =
        typeof ebayDraft.title === "string" && ebayDraft.title.trim().length >= 2
          ? ebayDraft.title.trim()
          : item.title.trim();
      const sug = await fetchFirstCategorySuggestion(env, env.EBAY_MARKETPLACE_ID, q);
      if (sug) {
        ebayDraft.category_id_hint = sug.categoryId;
        ebayDraft.category_name_hint = sug.categoryName;
      }
    } catch {
      /* optional Taxonomy enrichment */
    }
  }

  const { error: delErr } = await service.from("listing_drafts").delete().eq("inventory_item_id", item.id);
  if (delErr) {
    return { ok: false, message: delErr.message };
  }

  for (const p of PLATFORMS) {
    const { error: insErr } = await service.from("listing_drafts").insert({
      user_id: userId,
      inventory_item_id: item.id,
      platform: p,
      payload: drafts[p] as object,
    });
    if (insErr) {
      return { ok: false, message: insErr.message };
    }
  }

  await service
    .from("inventory_items")
    .update({ draft_ai_status: null, updated_at: new Date().toISOString() })
    .eq("id", item.id)
    .eq("user_id", userId);

  return { ok: true, summary, drafts };
}

export async function markAsyncDraftGenerationFailed(
  service: SupabaseClient,
  userId: string,
  inventoryItemId: string,
  message: string
): Promise<void> {
  const failedPayload = {
    [GENERATION_FAILED_PAYLOAD_KEY]: true,
    [GENERATION_ERROR_PAYLOAD_KEY]: message,
  };
  await service
    .from("inventory_items")
    .update({ draft_ai_status: "failed", updated_at: new Date().toISOString() })
    .eq("id", inventoryItemId)
    .eq("user_id", userId);
  await service
    .from("listing_drafts")
    .update({ payload: failedPayload, updated_at: new Date().toISOString() })
    .eq("inventory_item_id", inventoryItemId)
    .eq("user_id", userId);
}
