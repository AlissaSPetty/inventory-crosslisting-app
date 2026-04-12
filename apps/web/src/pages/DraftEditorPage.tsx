import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  EBAY_CONDITIONS,
  EBAY_DESCRIPTION_MAX,
  EBAY_TITLE_MAX,
  DRAFT_EDITOR_INITIAL_PHOTO_COUNT,
  INVENTORY_PHOTOS_MAX,
  normalizeEbayConditionForInventory,
  SHOPIFY_TITLE_MAX,
  validateDraftEditor,
  type DraftEditorPayload,
  type EbayShippingDraft,
  type ValidationIssue,
} from "@inv/shared";
import { DraftPhotoEditorModal } from "../components/DraftPhotoEditorModal.js";
import { apiFetch, ApiRequestError } from "../lib/api.js";
import { inventoryItemDisplayName } from "../lib/inventoryDisplay.js";
import { supabase } from "../lib/supabase.js";

type DetailResponse = {
  anchorDraft: { id: string; inventory_item_id: string; platform: string; payload: Record<string, unknown> };
  ebayDraft: { id: string; payload: Record<string, unknown> } | null;
  siblings: { id: string; platform: string; payload: Record<string, unknown> }[];
  inventoryItem: {
    id: string;
    title: string;
    sku: string | null;
    quantity_available: number;
    status: string;
    draft_ai_status?: string | null;
  };
  photos: { id: string; storage_path: string; sort_order: number; file_updated_at?: string | null }[];
  integrations: { platform: string; shop_domain: string | null }[];
};

type EbayPoliciesResponse = {
  fulfillmentPolicies: { id: string; name: string }[];
  paymentPolicies: { id: string; name: string }[];
  returnPolicies: { id: string; name: string }[];
};

type EbayCategorySuggestionsResponse = {
  suggestions: { categoryId: string; categoryName: string }[];
};

type EbayConditionPoliciesResponse = {
  conditions: { conditionId: string; label: string }[];
};

type EbayItemAspectRow = {
  localizedAspectName: string;
  aspectRequired: boolean;
  aspectMode: string;
  values: string[];
};

type EbayItemAspectsResponse = {
  aspects: EbayItemAspectRow[];
};

function publicListingPhotoUrl(storagePath: string): string {
  return supabase.storage.from("listing-photos").getPublicUrl(storagePath).data.publicUrl;
}

function photoCacheKey(ph: { file_updated_at?: string | null }): string {
  const t = ph.file_updated_at;
  if (typeof t === "string" && t.length) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return String(ms);
  }
  return "0";
}

/** Public object URL with cache-bust query (same path after storage upsert returns stale bytes in browsers). */
function publicPhotoUrlWithCache(ph: { storage_path: string; file_updated_at?: string | null }): string {
  return `${publicListingPhotoUrl(ph.storage_path)}?v=${photoCacheKey(ph)}`;
}

function priceFromAiCents(p: Record<string, unknown> | undefined): number | undefined {
  if (typeof p?.price_hint_cents === "number" && p.price_hint_cents > 0) {
    return p.price_hint_cents / 100;
  }
  return undefined;
}

function categoryIdFromAi(p: Record<string, unknown> | undefined): string {
  const raw = p?.category_id_hint;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (/^\d{3,12}$/.test(t)) return t;
  }
  return "";
}

function categoryNameFromAi(p: Record<string, unknown> | undefined): string {
  const raw = p?.category_name_hint;
  return typeof raw === "string" ? raw.trim() : "";
}

/** Clear legacy 0/0 weights saved when nulls were normalized to zero so fields show empty and validation matches intent. */
function legacyUnsetZeroPackageWeights(sh: EbayShippingDraft | undefined): EbayShippingDraft {
  if (!sh) return {};
  if (sh.packageWeightLbs === 0 && sh.packageWeightOz === 0) {
    return { ...sh, packageWeightLbs: null, packageWeightOz: null };
  }
  return sh;
}

function buildInitialEditor(data: DetailResponse): DraftEditorPayload {
  const ebayRow = data.ebayDraft ?? data.siblings.find((s) => s.platform === "ebay");
  const existing = (ebayRow?.payload?.editor ?? {}) as DraftEditorPayload;
  const sortedPhotos = [...data.photos].sort((a, b) => a.sort_order - b.sort_order);
  const defaultPhotoIds = sortedPhotos
    .slice(0, DRAFT_EDITOR_INITIAL_PHOTO_COUNT)
    .map((p) => p.id);
  const photoIds =
    existing.photoIds?.length && data.photos.some((p) => existing.photoIds?.includes(p.id))
      ? existing.photoIds
      : defaultPhotoIds;

  const ebaySib = data.siblings.find((s) => s.platform === "ebay")?.payload as Record<string, unknown> | undefined;
  const shopifySib = data.siblings.find((s) => s.platform === "shopify")?.payload as
    | Record<string, unknown>
    | undefined;
  const inv = data.inventoryItem;

  const aiEbayPrice = priceFromAiCents(ebaySib);
  const aiShopifyPrice = priceFromAiCents(shopifySib);
  const catHint = categoryIdFromAi(ebaySib);
  const catNameHint = categoryNameFromAi(ebaySib);

  return {
    photoIds,
    ebay: {
      title: (existing.ebay?.title ?? ebaySib?.title ?? inv.title) as string,
      description: (existing.ebay?.description ?? ebaySib?.body ?? "") as string,
      price: existing.ebay?.price ?? aiEbayPrice,
      quantity: existing.ebay?.quantity ?? Math.max(1, inv.quantity_available || 1),
      condition: normalizeEbayConditionForInventory(existing.ebay?.condition ?? "") || "NEW",
      categoryId: (existing.ebay?.categoryId ?? catHint) as string,
      listing: {
        ...(existing.ebay?.listing ?? {}),
        category: existing.ebay?.listing?.category ?? catNameHint,
        costOfGoods: existing.ebay?.listing?.costOfGoods,
        sku: existing.ebay?.listing?.sku ?? inv.sku ?? "",
        color: existing.ebay?.listing?.color ?? "",
      },
      shipping: legacyUnsetZeroPackageWeights({ ...(existing.ebay?.shipping ?? {}) }),
      pricing: { ...(existing.ebay?.pricing ?? {}) },
    },
    shopify: {
      title: (existing.shopify?.title ?? shopifySib?.title ?? inv.title) as string,
      bodyHtml: (existing.shopify?.bodyHtml ?? shopifySib?.body ?? "") as string,
      price: existing.shopify?.price ?? aiShopifyPrice,
      quantity: existing.shopify?.quantity ?? Math.max(1, inv.quantity_available || 1),
    },
  };
}

const FIELD_SCROLL_ORDER = [
  "photos",
  "ebay.title",
  "ebay.description",
  "ebay.price",
  "ebay.quantity",
  "ebay.condition",
  "ebay.categoryId",
  "shopify.title",
  "shopify.bodyHtml",
  "shopify.price",
  "shopify.quantity",
];

function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const rank = (f: string) => {
    if (f.startsWith("ebay.itemAspect.")) {
      const i = FIELD_SCROLL_ORDER.indexOf("ebay.categoryId");
      return i === -1 ? 999 : i + 0.5;
    }
    const i = FIELD_SCROLL_ORDER.indexOf(f);
    return i === -1 ? 999 : i;
  };
  return [...issues].sort((a, b) => rank(a.field) - rank(b.field));
}

function formatUsdInput(n: number | undefined): string {
  if (n == null || Number.isNaN(n) || n <= 0) return "";
  return String(n);
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
}

/** Deterministic JSON for comparing draft editor payloads (key order–independent). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

export function DraftEditorPage() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const formTopRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["listing-draft-detail", draftId],
    queryFn: () => apiFetch(`/api/listing-drafts/${draftId}`) as Promise<DetailResponse>,
    enabled: !!draftId,
  });

  const { data: ebayPolicies } = useQuery({
    queryKey: ["ebay-policies"],
    queryFn: () => apiFetch("/api/integrations/ebay/policies") as Promise<EbayPoliciesResponse>,
    enabled: !!data?.integrations?.some((i) => i.platform === "ebay"),
    retry: false,
  });

  const [editor, setEditor] = useState<DraftEditorPayload | null>(null);
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  /** Shown when publish returns structured failure (e.g. eBay 25020) without throwing. */
  const [publishFailureMessage, setPublishFailureMessage] = useState<string | null>(null);
  const [publishTargets, setPublishTargets] = useState<Record<string, boolean>>({});
  /** Photo being edited in the modal (replace file at same storage path, same DB row). */
  const [editingPhoto, setEditingPhoto] = useState<{
    id: string;
    storage_path: string;
    imageUrl: string;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  /** Serialized `buildInitialEditor` / last successful save — for dirty detection. */
  const [baselineEditorJson, setBaselineEditorJson] = useState("");
  const [pendingInventoryNav, setPendingInventoryNav] = useState(false);
  const [categoryInput, setCategoryInput] = useState("");
  const [debouncedCatQ, setDebouncedCatQ] = useState("");
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);

  useEffect(() => {
    const tid = setTimeout(() => setDebouncedCatQ(categoryInput.trim()), 350);
    return () => clearTimeout(tid);
  }, [categoryInput]);

  const categoryIdForConditions = editor?.ebay?.categoryId?.trim() ?? "";

  const { data: categorySuggestData } = useQuery({
    queryKey: ["ebay-category-suggestions", debouncedCatQ],
    queryFn: () =>
      apiFetch(
        `/api/integrations/ebay/category-suggestions?q=${encodeURIComponent(debouncedCatQ)}`
      ) as Promise<EbayCategorySuggestionsResponse>,
    enabled: debouncedCatQ.length >= 2,
    retry: false,
  });

  const { data: condPolicyData } = useQuery({
    queryKey: ["ebay-condition-policies", categoryIdForConditions],
    queryFn: () =>
      apiFetch(
        `/api/integrations/ebay/item-condition-policies?categoryId=${encodeURIComponent(categoryIdForConditions)}`
      ) as Promise<EbayConditionPoliciesResponse>,
    enabled: !!categoryIdForConditions && /^\d+$/.test(categoryIdForConditions),
    retry: false,
  });

  const { data: ebayAspectsData, isFetching: ebayAspectsFetching } = useQuery({
    queryKey: ["ebay-item-aspects", categoryIdForConditions],
    queryFn: () =>
      apiFetch(
        `/api/integrations/ebay/item-aspects?categoryId=${encodeURIComponent(categoryIdForConditions)}`
      ) as Promise<EbayItemAspectsResponse>,
    enabled: !!categoryIdForConditions && /^\d+$/.test(categoryIdForConditions),
    retry: false,
  });

  const ebayRequiredAspectNames = useMemo(
    () =>
      (ebayAspectsData?.aspects ?? [])
        .filter((a) => a.aspectRequired)
        .map((a) => a.localizedAspectName),
    [ebayAspectsData]
  );

  const conditionSelectOptions = useMemo(() => {
    if (condPolicyData?.conditions?.length) return condPolicyData.conditions;
    return EBAY_CONDITIONS.map((c) => ({ conditionId: c, label: c.replace(/_/g, " ") }));
  }, [condPolicyData]);

  useEffect(() => {
    if (!condPolicyData?.conditions?.length) return;
    const allowed = new Set(condPolicyData.conditions.map((c) => c.conditionId));
    setEditor((prev) => {
      if (!prev?.ebay) return prev;
      const raw = prev.ebay.condition ?? "";
      const cur = normalizeEbayConditionForInventory(raw);
      if (cur && allowed.has(cur)) {
        return cur !== raw ? { ...prev, ebay: { ...prev.ebay, condition: cur } } : prev;
      }
      const next = condPolicyData.conditions[0]?.conditionId ?? "NEW";
      return { ...prev, ebay: { ...prev.ebay, condition: next } };
    });
  }, [condPolicyData, categoryIdForConditions]);

  const prevCategoryRef = useRef<string | null>(null);
  useEffect(() => {
    const cur = categoryIdForConditions;
    if (prevCategoryRef.current === null) {
      prevCategoryRef.current = cur;
      return;
    }
    if (prevCategoryRef.current === cur) return;
    const prev = prevCategoryRef.current;
    prevCategoryRef.current = cur;
    if (prev === "" && cur) return;
    if (!prev || !cur) return;
    setEditor((e) => {
      if (!e?.ebay) return e;
      return {
        ...e,
        ebay: {
          ...e.ebay,
          listing: { ...(e.ebay.listing ?? {}), itemAspects: {} },
        },
      };
    });
  }, [categoryIdForConditions]);

  useEffect(() => {
    if (!data) return;
    const built = buildInitialEditor(data);
    setBaselineEditorJson(stableStringify(built));
    setEditor(built);
    const id = built.ebay?.categoryId?.trim() ?? "";
    const name = (built.ebay?.listing?.category as string | undefined)?.trim() ?? "";
    if (name && id) setCategoryInput(`${name} (${id})`);
    else if (id) setCategoryInput(id);
    else setCategoryInput("");
    const connected = new Set(data.integrations.map((i) => i.platform));
    const initial: Record<string, boolean> = {};
    for (const p of ["ebay", "shopify", "depop", "poshmark", "mercari"] as const) {
      initial[p] = connected.has(p);
    }
    setPublishTargets(initial);
  }, [data]);

  const connectedSet = useMemo(
    () => new Set(data?.integrations.map((i) => i.platform) ?? []),
    [data]
  );

  const sortedPhotos = useMemo(() => {
    if (!data?.photos?.length) return [];
    return [...data.photos].sort((a, b) => a.sort_order - b.sort_order);
  }, [data?.photos]);

  const ebayPayloadBase = useMemo(() => {
    const row = data?.ebayDraft ?? data?.siblings?.find((s) => s.platform === "ebay");
    const p = (row?.payload ?? {}) as Record<string, unknown>;
    const { editor: _e, ...rest } = p;
    return rest;
  }, [data?.ebayDraft, data?.siblings]);

  const saveMutation = useMutation({
    mutationFn: async (opts?: { navigateAfter?: boolean }) => {
      if (!draftId || !editor) throw new Error("Missing data");
      const snapshot = editor;
      const issues = validateDraftEditor(snapshot, ["ebay", "shopify"]);
      if (issues.length) {
        const sorted = sortIssues(issues);
        const invMap: Record<string, boolean> = {};
        for (const i of issues) invMap[i.field] = true;
        setInvalid(invMap);
        setTimeout(() => scrollToFirstError(sorted[0]?.field), 0);
        throw new Error(sorted[0]?.message ?? "Validation failed");
      }
      setInvalid({});
      await apiFetch(`/api/listing-drafts/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({
          payload: { ...ebayPayloadBase, editor: snapshot },
        }),
      });
      return { editor: snapshot, navigateAfter: opts?.navigateAfter ?? false };
    },
    onSuccess: (result) => {
      setBaselineEditorJson(stableStringify(result.editor));
      qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      if (result.navigateAfter) navigate("/drafts");
    },
  });

  const isDirty = useMemo(() => {
    if (!editor) return false;
    return stableStringify(editor) !== baselineEditorJson;
  }, [editor, baselineEditorJson]);

  function handleInventoryLinkClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!isDirty) return;
    e.preventDefault();
    setPendingInventoryNav(true);
  }

  const publishMutation = useMutation({
    mutationFn: async () => {
      setPublishFailureMessage(null);
      if (!draftId || !editor) throw new Error("Missing data");
      const selected = (["ebay", "shopify", "depop", "poshmark", "mercari"] as const).filter(
        (p) => publishTargets[p]
      );
      if (!selected.length) throw new Error("Select at least one platform to publish");
      if (
        selected.includes("ebay") &&
        categoryIdForConditions &&
        /^\d+$/.test(categoryIdForConditions) &&
        ebayAspectsFetching
      ) {
        throw new Error("Loading eBay item specifics for this category…");
      }
      const issues = validateDraftEditor(editor, selected, {
        ebayRequiredAspectNames: selected.includes("ebay") ? ebayRequiredAspectNames : undefined,
      });
      if (issues.length) {
        const sorted = sortIssues(issues);
        const invMap: Record<string, boolean> = {};
        for (const i of issues) invMap[i.field] = true;
        setInvalid(invMap);
        setTimeout(() => scrollToFirstError(sorted[0]?.field), 0);
        throw new Error(sorted[0]?.message ?? "Validation failed");
      }
      setInvalid({});
      return apiFetch(`/api/listing-drafts/${draftId}/publish`, {
        method: "POST",
        body: JSON.stringify({
          platforms: selected,
          /** Persist latest editor to the eBay draft row before publish (same merge as PATCH). */
          payload: { ...ebayPayloadBase, editor },
        }),
      }) as Promise<{
        ok: boolean;
        results?: Record<
          string,
          { ok: boolean; message?: string; url?: string; clientField?: string; userMessage?: string }
        >;
      }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
      qc.invalidateQueries({ queryKey: ["listing-drafts"] });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["platform-listings"] });
      if (!data?.ok || !data.results) return;
      const results = data.results;
      const entries = Object.entries(results);
      const allOk = entries.every(([, v]) => v.ok);
      const failed = entries.filter(([, v]) => !v.ok);
      if (failed.length > 0) {
        const ebay = results.ebay;
        if (ebay && !ebay.ok) {
          const cf = ebay.clientField;
          if (cf) {
            setInvalid((prev) => ({ ...prev, [cf]: true }));
            setTimeout(() => scrollToFirstError(cf), 0);
          }
          setPublishFailureMessage(ebay.userMessage ?? ebay.message ?? "eBay publish failed.");
        } else {
          const firstMsg = failed.map(([, v]) => v.message).find(Boolean);
          setPublishFailureMessage(firstMsg ?? "Publish failed.");
        }
      } else {
        setPublishFailureMessage(null);
      }
      if (allOk) {
        navigate("/drafts", { replace: true });
      }
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 502) {
        const body = err.body as {
          results?: { ebay?: { clientField?: string; userMessage?: string; message?: string } };
        };
        const ebay = body.results?.ebay;
        const cf = ebay?.clientField;
        if (cf) {
          setInvalid((prev) => ({ ...prev, [cf]: true }));
          setTimeout(() => scrollToFirstError(cf), 0);
        }
        setPublishFailureMessage(ebay?.userMessage ?? ebay?.message ?? err.message);
      }
    },
  });

  function scrollToFirstError(field: string | undefined) {
    if (!field) {
      formTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      formTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function updateEbay<K extends keyof NonNullable<DraftEditorPayload["ebay"]>>(
    key: K,
    value: NonNullable<DraftEditorPayload["ebay"]>[K]
  ) {
    setEditor((e) =>
      e
        ? {
            ...e,
            ebay: { ...(e.ebay ?? {}), [key]: value },
          }
        : e
    );
  }

  function updateEbayShipping(patch: Partial<EbayShippingDraft>) {
    if (
      ("packageWeightLbs" in patch || "packageWeightOz" in patch) &&
      invalid["ebay.shipping.packageWeight"]
    ) {
      setPublishFailureMessage(null);
      setInvalid((prev) => {
        const next = { ...prev };
        delete next["ebay.shipping.packageWeight"];
        return next;
      });
    }
    setEditor((e) => {
      if (!e?.ebay) return e;
      return {
        ...e,
        ebay: {
          ...e.ebay,
          shipping: { ...(e.ebay.shipping ?? {}), ...patch },
        },
      };
    });
  }

  function updateEbayListing(patch: Record<string, unknown>) {
    setEditor((e) => {
      if (!e?.ebay) return e;
      return {
        ...e,
        ebay: {
          ...e.ebay,
          listing: { ...(e.ebay.listing ?? {}), ...patch },
        },
      };
    });
  }

  function updateEbayItemAspect(aspectName: string, value: string) {
    setEditor((e) => {
      if (!e?.ebay) return e;
      const prev = e.ebay.listing?.itemAspects ?? {};
      return {
        ...e,
        ebay: {
          ...e.ebay,
          listing: {
            ...(e.ebay.listing ?? {}),
            itemAspects: { ...prev, [aspectName]: value },
          },
        },
      };
    });
  }

  function updateEbayPricing(patch: Record<string, unknown>) {
    setEditor((e) => {
      if (!e?.ebay) return e;
      return {
        ...e,
        ebay: {
          ...e.ebay,
          pricing: { ...(e.ebay.pricing ?? {}), ...patch },
        },
      };
    });
  }

  function updateShopify<K extends keyof NonNullable<DraftEditorPayload["shopify"]>>(
    key: K,
    value: NonNullable<DraftEditorPayload["shopify"]>[K]
  ) {
    setEditor((e) =>
      e
        ? {
            ...e,
            shopify: { ...(e.shopify ?? {}), [key]: value },
          }
        : e
    );
  }

  function togglePhoto(id: string, include: boolean) {
    setEditor((e) => {
      if (!e) return e;
      const set = new Set(e.photoIds ?? []);
      if (include) set.add(id);
      else set.delete(id);
      return { ...e, photoIds: [...set] };
    });
  }

  async function uploadPhoto(file: File) {
    if (!data?.inventoryItem?.id) return;
    if (data.photos.length >= INVENTORY_PHOTOS_MAX) {
      window.alert(`You can upload at most ${INVENTORY_PHOTOS_MAX} photos per item.`);
      return;
    }
    const itemId = data.inventoryItem.id;
    const path = `${(await supabase.auth.getUser()).data.user?.id}/${crypto.randomUUID()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("listing-photos").upload(path, file);
    if (upErr) throw upErr;
    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (!uid) return;
    const maxOrder = Math.max(0, ...data.photos.map((p) => p.sort_order));
    await supabase.from("inventory_images").insert({
      user_id: uid,
      inventory_item_id: itemId,
      storage_path: path,
      sort_order: maxOrder + 1,
    });
    qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
    qc.invalidateQueries({ queryKey: ["listing-drafts"] });
  }

  async function replacePhotoAtPath(photoId: string, storagePath: string, file: File) {
    const { error: upErr } = await supabase.storage
      .from("listing-photos")
      .upload(storagePath, file, { upsert: true, contentType: file.type || "image/jpeg" });
    if (upErr) {
      window.alert(upErr.message);
      return;
    }
    const { error: rowErr } = await supabase
      .from("inventory_images")
      .update({ file_updated_at: new Date().toISOString() })
      .eq("id", photoId);
    if (rowErr) {
      window.alert(rowErr.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
    qc.invalidateQueries({ queryKey: ["listing-drafts"] });
  }

  async function deletePhoto(photoId: string, storagePath: string) {
    if (!confirm("Remove this photo from the item? This cannot be undone.")) return;
    await supabase.storage.from("listing-photos").remove([storagePath]);
    await supabase.from("inventory_images").delete().eq("id", photoId);
    setEditor((e) => {
      if (!e) return e;
      const ids = (e.photoIds ?? []).filter((id) => id !== photoId);
      return { ...e, photoIds: ids };
    });
    qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
    qc.invalidateQueries({ queryKey: ["listing-drafts"] });
  }

  async function persistPhotoOrder(orderedIds: string[]) {
    const results = await Promise.all(
      orderedIds.map((id, i) =>
        supabase.from("inventory_images").update({ sort_order: i }).eq("id", id)
      )
    );
    const firstErr = results.find((r) => r.error)?.error;
    if (firstErr) {
      window.alert(firstErr.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["listing-draft-detail", draftId] });
    qc.invalidateQueries({ queryKey: ["listing-drafts"] });
  }

  async function reorderPhotos(draggedId: string, targetId: string) {
    if (draggedId === targetId || reorderBusy) return;
    const from = sortedPhotos.findIndex((p) => p.id === draggedId);
    const to = sortedPhotos.findIndex((p) => p.id === targetId);
    if (from === -1 || to === -1) return;
    const next = arrayMove(sortedPhotos, from, to);
    setReorderBusy(true);
    try {
      await persistPhotoOrder(next.map((p) => p.id));
    } finally {
      setReorderBusy(false);
    }
  }

  const shippingSectionError = useMemo(() => {
    const msg =
      publishFailureMessage ??
      (publishMutation.isError ? (publishMutation.error as Error)?.message : undefined) ??
      (saveMutation.isError ? (saveMutation.error as Error)?.message : undefined) ??
      null;
    if (!msg) return null;
    const isShipping =
      /\bpackage weight\b/i.test(msg) ||
      /\bshipping weight\b/i.test(msg) ||
      /weight.*publish/i.test(msg) ||
      /\b25020\b/.test(msg) ||
      /^Add a valid package weight/i.test(msg.trim());
    return isShipping ? msg : null;
  }, [
    publishFailureMessage,
    publishMutation.isError,
    publishMutation.error,
    saveMutation.isError,
    saveMutation.error,
  ]);

  const showTopFormError =
    (saveMutation.isError || publishMutation.isError || publishFailureMessage) && !shippingSectionError;

  if (isLoading || !data) {
    return (
      <div>
        <p>Loading…</p>
        {error && <p className="error">{(error as Error).message}</p>}
      </div>
    );
  }

  const stillProcessing =
    data.inventoryItem.draft_ai_status === "pending" ||
    data.siblings.some((s) => (s.payload as Record<string, unknown>)?._generationPending === true);
  if (stillProcessing) {
    return (
      <div>
        <p>
          <Link to="/drafts">← Listing drafts</Link>
        </p>
        <h1>Processing drafts</h1>
        <p style={{ color: "#64748b" }}>
          AI is still generating listing copy and category hints. Open{" "}
          <Link to="/drafts">Listing drafts</Link> to watch progress — refresh this page when the row shows{" "}
          <strong>Edit & publish</strong>.
        </p>
      </div>
    );
  }

  const genFailed =
    data.inventoryItem.draft_ai_status === "failed" ||
    data.siblings.some((s) => (s.payload as Record<string, unknown>)?._generationFailed === true);
  if (genFailed) {
    const failedSib = data.siblings.find(
      (s) => (s.payload as Record<string, unknown>)?._generationFailed === true
    );
    const pl = failedSib?.payload as Record<string, unknown> | undefined;
    const errMsg = typeof pl?._error === "string" ? pl._error : "Draft generation failed.";
    return (
      <div>
        <p>
          <Link to="/drafts">← Listing drafts</Link>
        </p>
        <h1>Draft generation failed</h1>
        <p className="error">{errMsg}</p>
        <p style={{ color: "#64748b" }}>
          You can remove this item from Listing drafts or try starting again from{" "}
          <Link to="/drafts/new">Add new draft</Link>.
        </p>
      </div>
    );
  }

  if (!data.siblings.some((s) => s.platform === "ebay")) {
    return (
      <div>
        <p>
          <Link to="/drafts">← Listing drafts</Link>
        </p>
        <p className="error">No eBay draft for this item. Run Generate drafts on the inventory row first.</p>
      </div>
    );
  }

  if (data && !editor) {
    return <p>Preparing form…</p>;
  }

  if (!editor) {
    return <p className="error">Could not load editor.</p>;
  }

  const eb = editor.ebay ?? {};
  const sh = editor.shopify ?? {};
  const pr = eb.pricing ?? {};
  const ship = eb.shipping ?? {};
  const list = eb.listing ?? {};

  return (
    <div ref={formTopRef}>
      <p style={{ marginBottom: "1rem" }}>
        <Link to="/drafts" onClick={handleInventoryLinkClick}>
          ← Listing drafts
        </Link>
      </p>
      <h1>Edit listing draft</h1>
      <p style={{ color: "#64748b" }}>
        Item:{" "}
        <strong>
          {inventoryItemDisplayName(
            data.inventoryItem.title,
            eb.title?.trim() || sh.title?.trim() || undefined
          )}
        </strong>{" "}
        · Qty {data.inventoryItem.quantity_available}
      </p>

      {showTopFormError && (
        <p className="error" role="alert">
          {publishFailureMessage ??
            (saveMutation.error as Error)?.message ??
            (publishMutation.error as Error)?.message}
        </p>
      )}

      <div className="card">
        <h2>Photos</h2>
        <p style={{ marginTop: 0, fontSize: "0.9rem", color: "#64748b" }}>
          Check photos to include in published listings. Drag the grip (⋮⋮) to reorder gallery order for publishing.
          Use Add to upload, Edit for rotate/crop/color, Remove to delete from this item. Estimated resale pricing and
          category hints come from AI when you run <strong>Generate drafts</strong> (not live sold data).
        </p>
        <p style={{ marginBottom: "0.5rem" }}>
          <label>
            Add photos
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ marginLeft: "0.5rem" }}
              onChange={(e) => {
                const files = e.target.files;
                if (!files?.length) return;
                void (async () => {
                  const slots = Math.max(0, INVENTORY_PHOTOS_MAX - data.photos.length);
                  const list = Array.from(files);
                  const toAdd = list.slice(0, slots);
                  if (list.length > toAdd.length) {
                    window.alert(
                      `Only ${INVENTORY_PHOTOS_MAX} photos per item. Extra files were not uploaded.`
                    );
                  }
                  for (const f of toAdd) {
                    await uploadPhoto(f);
                  }
                })();
                e.target.value = "";
              }}
            />
          </label>
        </p>
        <div data-field="photos" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          {sortedPhotos.length === 0 && <span style={{ color: "#94a3b8" }}>No photos uploaded.</span>}
          {sortedPhotos.map((ph) => {
            const checked = editor.photoIds?.includes(ph.id) ?? false;
            const isDragOver = dragOverId === ph.id && draggingId != null && draggingId !== ph.id;
            return (
              <div
                key={ph.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (draggingId && draggingId !== ph.id) setDragOverId(ph.id);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData("text/plain");
                  setDragOverId(null);
                  setDraggingId(null);
                  if (draggedId) void reorderPhotos(draggedId, ph.id);
                }}
                style={{
                  border: invalid.photos
                    ? "2px solid #b91c1c"
                    : isDragOver
                      ? "2px solid #3b82f6"
                      : "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: 6,
                  display: "inline-block",
                  opacity: draggingId === ph.id ? 0.55 : 1,
                }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <div
                    draggable={!reorderBusy}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", ph.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingId(ph.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDragOverId(null);
                    }}
                    title="Drag to reorder"
                    style={{
                      cursor: reorderBusy ? "not-allowed" : "grab",
                      userSelect: "none",
                      lineHeight: 1,
                      padding: "0.35rem 0.15rem",
                      color: "#64748b",
                      fontSize: "0.85rem",
                    }}
                  >
                    ⋮⋮
                  </div>
                  <div>
                    <div style={{ position: "relative" }}>
                      <img
                        src={publicPhotoUrlWithCache(ph)}
                        alt=""
                        draggable={false}
                        style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 4, display: "block" }}
                      />
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => togglePhoto(ph.id, e.target.checked)}
                        style={{ position: "absolute", top: 4, left: 4 }}
                        title="Include in listings"
                      />
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      <button
                        type="button"
                    onClick={() =>
                      setEditingPhoto({
                        id: ph.id,
                        storage_path: ph.storage_path,
                        imageUrl: publicPhotoUrlWithCache(ph),
                      })
                    }
                      >
                        Edit
                      </button>
                      <button type="button" onClick={() => void deletePhoto(ph.id, ph.storage_path)}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {editingPhoto && data.inventoryItem?.id && (
        <DraftPhotoEditorModal
          imageUrl={editingPhoto.imageUrl}
          onClose={() => setEditingPhoto(null)}
          onSave={(file) => {
            const target = editingPhoto;
            setEditingPhoto(null);
            void replacePhotoAtPath(target.id, target.storage_path, file);
          }}
        />
      )}

      {pendingInventoryNav && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unsaved-draft-dialog-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div className="card" style={{ maxWidth: 420, width: "100%" }}>
            <h2 id="unsaved-draft-dialog-title" style={{ marginTop: 0 }}>
              Unsaved changes
            </h2>
            <p style={{ marginTop: 0, color: "#64748b" }}>
              You have unsaved changes. Save all changes before returning to Listing drafts?
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="primary"
                disabled={saveMutation.isPending}
                onClick={() => {
                  void saveMutation.mutateAsync({ navigateAfter: true }).catch(() => {
                    /* validation/network errors: stay on page with dialog open */
                  });
                }}
              >
                {saveMutation.isPending ? "Saving…" : "Yes, save"}
              </button>
              <button
                type="button"
                disabled={saveMutation.isPending}
                onClick={() => {
                  setPendingInventoryNav(false);
                  navigate("/drafts");
                }}
              >
                No, leave without saving
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>eBay</h2>
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
          <label data-field="ebay.title">
            Title ({eb.title?.length ?? 0}/{EBAY_TITLE_MAX})
            <input
              style={{ width: "100%", borderColor: invalid["ebay.title"] ? "#b91c1c" : undefined }}
              value={eb.title ?? ""}
              onChange={(e) => updateEbay("title", e.target.value)}
              maxLength={EBAY_TITLE_MAX}
            />
          </label>
          <label data-field="ebay.description">
            Description ({eb.description?.length ?? 0}/{EBAY_DESCRIPTION_MAX})
            <textarea
              style={{ width: "100%", minHeight: 140, borderColor: invalid["ebay.description"] ? "#b91c1c" : undefined }}
              value={eb.description ?? ""}
              onChange={(e) => updateEbay("description", e.target.value)}
              maxLength={EBAY_DESCRIPTION_MAX}
            />
          </label>
          <label data-field="ebay.quantity">
            Quantity
            <input
              type="number"
              min={1}
              style={{ width: 120, borderColor: invalid["ebay.quantity"] ? "#b91c1c" : undefined }}
              value={eb.quantity ?? 1}
              onChange={(e) => updateEbay("quantity", Number(e.target.value))}
            />
          </label>
        </div>

        <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Listing details (eBay)</h3>
        <p style={{ marginTop: 0, fontSize: "0.85rem", color: "#64748b" }}>
          Categories follow the eBay Taxonomy API flow (
          <a
            href="https://developer.ebay.com/api-docs/sell/static/metadata/sell-categories.html"
            target="_blank"
            rel="noreferrer"
          >
            finding categories for a listing
          </a>
          ). Search by name, pick a leaf category, then choose a condition allowed for that category.
        </p>
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
          <label data-field="ebay.categoryId" style={{ position: "relative", zIndex: 1 }}>
            eBay category (leaf)
            <input
              style={{ width: "100%", borderColor: invalid["ebay.categoryId"] ? "#b91c1c" : undefined }}
              value={categoryInput}
              onChange={(e) => {
                setCategoryInput(e.target.value);
                setCategoryMenuOpen(true);
              }}
              onFocus={() => setCategoryMenuOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setCategoryMenuOpen(false), 200);
                const raw = categoryInput.trim();
                if (/^\d{3,12}$/.test(raw)) {
                  updateEbay("categoryId", raw);
                  updateEbayListing({ category: "" });
                  setCategoryInput(raw);
                }
              }}
              placeholder="Type at least 2 characters to search, or enter a leaf category ID"
              autoComplete="off"
            />
            {categoryMenuOpen &&
              debouncedCatQ.length >= 2 &&
              (categorySuggestData?.suggestions?.length ?? 0) > 0 && (
                <ul
                  style={{
                    position: "absolute",
                    zIndex: 20,
                    left: 0,
                    right: 0,
                    top: "100%",
                    marginTop: 2,
                    maxHeight: 240,
                    overflow: "auto",
                    padding: "0.25rem 0",
                    listStyle: "none",
                    background: "#fff",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                  }}
                >
                  {categorySuggestData!.suggestions!.map((s) => (
                    <li key={s.categoryId}>
                      <button
                        type="button"
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "0.45rem 0.65rem",
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          font: "inherit",
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          updateEbay("categoryId", s.categoryId);
                          updateEbayListing({ category: s.categoryName });
                          setCategoryInput(`${s.categoryName} (${s.categoryId})`);
                          setCategoryMenuOpen(false);
                        }}
                      >
                        <strong>{s.categoryName}</strong>
                        <span style={{ color: "#64748b", marginLeft: 6 }}>({s.categoryId})</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </label>
          <label data-field="ebay.condition">
            Condition (for this category)
            <select
              style={{ width: "100%", borderColor: invalid["ebay.condition"] ? "#b91c1c" : undefined }}
              value={eb.condition ?? "NEW"}
              onChange={(e) => updateEbay("condition", e.target.value)}
            >
              {conditionSelectOptions.map((c, idx) => (
                <option key={`${c.conditionId}-${idx}`} value={c.conditionId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {categoryIdForConditions && /^\d+$/.test(categoryIdForConditions) && ebayAspectsFetching && (
            <p style={{ margin: 0, fontSize: "0.85rem", color: "#64748b" }}>Loading item specifics…</p>
          )}
          {(ebayAspectsData?.aspects ?? [])
            .filter((a) => a.aspectRequired)
            .map((a) => {
              const field = `ebay.itemAspect.${a.localizedAspectName}`;
              const ia = (list.itemAspects ?? {}) as Record<string, string>;
              const val = ia[a.localizedAspectName] ?? "";
              const isInvalid = invalid[field];
              const useSelect = a.aspectMode === "SELECTION_ONLY" && a.values.length > 0;
              return (
                <label key={a.localizedAspectName} data-field={field}>
                  {a.localizedAspectName} (required)
                  {useSelect ? (
                    <select
                      style={{ width: "100%", borderColor: isInvalid ? "#b91c1c" : undefined }}
                      value={val}
                      onChange={(e) => updateEbayItemAspect(a.localizedAspectName, e.target.value)}
                    >
                      <option value="">Select…</option>
                      {a.values.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={{ width: "100%", borderColor: isInvalid ? "#b91c1c" : undefined }}
                      value={val}
                      onChange={(e) => updateEbayItemAspect(a.localizedAspectName, e.target.value)}
                      placeholder={a.localizedAspectName}
                    />
                  )}
                </label>
              );
            })}
          <label>
            Cost of goods (optional, stored for your records)
            <input
              type="text"
              inputMode="decimal"
              style={{ width: 200 }}
              value={formatUsdInput(list.costOfGoods as number | undefined)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                if (raw === "") {
                  updateEbayListing({ costOfGoods: undefined });
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) updateEbayListing({ costOfGoods: n });
              }}
            />
          </label>
          <label>
            SKU (optional)
            <input
              style={{ width: "100%" }}
              value={(list.sku as string) ?? ""}
              onChange={(e) => updateEbayListing({ sku: e.target.value })}
              placeholder="Inventory SKU for this listing"
            />
          </label>
          <label>
            Color (optional)
            <input
              style={{ width: "100%" }}
              value={(list.color as string) ?? ""}
              onChange={(e) => updateEbayListing({ color: e.target.value })}
              placeholder="Shown at top of description when set"
            />
          </label>
        </div>

        <div
          data-field="ebay.shipping.packageWeight"
          style={{
            marginTop: "1.25rem",
            padding: "0.75rem",
            borderRadius: 8,
            border: invalid["ebay.shipping.packageWeight"] ? "2px solid #b91c1c" : "1px solid transparent",
            background: invalid["ebay.shipping.packageWeight"] ? "#fef2f2" : undefined,
          }}
        >
        <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Shipping (eBay)</h3>
        {shippingSectionError && (
          <p className="error" role="alert" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
            {shippingSectionError}
          </p>
        )}
        <p style={{ marginTop: 0, fontSize: "0.85rem", color: "#64748b" }}>
          Uses your eBay business policies. Leave blank to use the first policy from your account for each type.
          Package weight is required for eBay to accept the listing.
        </p>
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
          <label>
            Shipping policy (fulfillment)
            <select
              style={{ width: "100%" }}
              value={ship.fulfillmentPolicyId ?? ""}
              onChange={(e) => updateEbayShipping({ fulfillmentPolicyId: e.target.value || null })}
            >
              <option value="">Default (first in account)</option>
              {(ebayPolicies?.fulfillmentPolicies ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Package weight — pounds
            <input
              type="number"
              min={0}
              step={0.01}
              style={{ width: 120 }}
              value={ship.packageWeightLbs ?? ""}
              onChange={(e) =>
                updateEbayShipping({
                  packageWeightLbs: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Package weight — ounces
            <input
              type="number"
              min={0}
              step={0.1}
              style={{ width: 120 }}
              value={ship.packageWeightOz ?? ""}
              onChange={(e) =>
                updateEbayShipping({
                  packageWeightOz: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Length (in)
            <input
              type="number"
              min={0}
              step={0.1}
              style={{ width: 120 }}
              value={ship.packageLengthIn ?? ""}
              onChange={(e) =>
                updateEbayShipping({
                  packageLengthIn: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Width (in)
            <input
              type="number"
              min={0}
              step={0.1}
              style={{ width: 120 }}
              value={ship.packageWidthIn ?? ""}
              onChange={(e) =>
                updateEbayShipping({
                  packageWidthIn: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Height (in)
            <input
              type="number"
              min={0}
              step={0.1}
              style={{ width: 120 }}
              value={ship.packageHeightIn ?? ""}
              onChange={(e) =>
                updateEbayShipping({
                  packageHeightIn: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 4 }}>Irregular package</legend>
            <label style={{ marginRight: "1rem" }}>
              <input
                type="radio"
                name="irregular"
                checked={ship.irregularPackage === true}
                onChange={() => updateEbayShipping({ irregularPackage: true })}
              />{" "}
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="irregular"
                checked={ship.irregularPackage === false}
                onChange={() => updateEbayShipping({ irregularPackage: false })}
              />{" "}
              No
            </label>
            <label style={{ marginLeft: "1rem" }}>
              <input
                type="radio"
                name="irregular"
                checked={ship.irregularPackage == null}
                onChange={() => updateEbayShipping({ irregularPackage: null })}
              />{" "}
              Unset
            </label>
          </fieldset>
          <label>
            Return policy
            <select
              style={{ width: "100%" }}
              value={ship.returnPolicyId ?? ""}
              onChange={(e) => updateEbayShipping({ returnPolicyId: e.target.value || null })}
            >
              <option value="">Default (first in account)</option>
              {(ebayPolicies?.returnPolicies ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Payment policy
            <select
              style={{ width: "100%" }}
              value={ship.paymentPolicyId ?? ""}
              onChange={(e) => updateEbayShipping({ paymentPolicyId: e.target.value || null })}
            >
              <option value="">Default (first in account)</option>
              {(ebayPolicies?.paymentPolicies ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        </div>

        <h3 style={{ marginTop: "1.25rem", marginBottom: "0.5rem" }}>Pricing (eBay)</h3>
        <p style={{ marginTop: 0, fontSize: "0.85rem", color: "#64748b" }}>
          List price is prefilled from the AI estimate when you run Generate drafts. Other platforms can mirror this
          pattern later.
        </p>
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
          <label data-field="ebay.price">
            Price (USD)
            <input
              type="text"
              inputMode="decimal"
              style={{ width: 200, borderColor: invalid["ebay.price"] ? "#b91c1c" : undefined }}
              value={formatUsdInput(eb.price)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                if (raw === "" || raw === ".") {
                  updateEbay("price", undefined);
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) updateEbay("price", n);
              }}
            />
          </label>
          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 4 }}>Allow Best Offer</legend>
            <label style={{ marginRight: "1rem" }}>
              <input
                type="radio"
                name="bo"
                checked={pr.bestOfferEnabled === true}
                onChange={() => updateEbayPricing({ bestOfferEnabled: true })}
              />{" "}
              Yes
            </label>
            <label>
              <input
                type="radio"
                name="bo"
                checked={pr.bestOfferEnabled !== true}
                onChange={() => updateEbayPricing({ bestOfferEnabled: false })}
              />{" "}
              No
            </label>
          </fieldset>
          <label data-field="ebay.pricing.minimumOfferUsd">
            Minimum offer / auto-decline at or below (USD)
            <input
              type="text"
              inputMode="decimal"
              style={{ width: 200, borderColor: invalid["ebay.pricing.minimumOfferUsd"] ? "#b91c1c" : undefined }}
              value={formatUsdInput(pr.minimumOfferUsd as number | undefined)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                if (raw === "") {
                  updateEbayPricing({ minimumOfferUsd: null });
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) updateEbayPricing({ minimumOfferUsd: n });
              }}
            />
          </label>
          <label data-field="ebay.pricing.autoAcceptUsd">
            Auto-accept at or above (USD)
            <input
              type="text"
              inputMode="decimal"
              style={{ width: 200, borderColor: invalid["ebay.pricing.autoAcceptUsd"] ? "#b91c1c" : undefined }}
              value={formatUsdInput(pr.autoAcceptUsd as number | undefined)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                if (raw === "") {
                  updateEbayPricing({ autoAcceptUsd: null });
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) updateEbayPricing({ autoAcceptUsd: n });
              }}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Shopify</h2>
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
          <label data-field="shopify.title">
            Title ({sh.title?.length ?? 0}/{SHOPIFY_TITLE_MAX})
            <input
              style={{ width: "100%", borderColor: invalid["shopify.title"] ? "#b91c1c" : undefined }}
              value={sh.title ?? ""}
              onChange={(e) => updateShopify("title", e.target.value)}
              maxLength={SHOPIFY_TITLE_MAX}
            />
          </label>
          <label data-field="shopify.bodyHtml">
            Description (HTML)
            <textarea
              style={{ width: "100%", minHeight: 120, borderColor: invalid["shopify.bodyHtml"] ? "#b91c1c" : undefined }}
              value={sh.bodyHtml ?? ""}
              onChange={(e) => updateShopify("bodyHtml", e.target.value)}
            />
          </label>
          <label data-field="shopify.price">
            Price (USD)
            <input
              type="text"
              inputMode="decimal"
              style={{ width: 200, borderColor: invalid["shopify.price"] ? "#b91c1c" : undefined }}
              value={formatUsdInput(sh.price)}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                if (raw === "" || raw === ".") {
                  updateShopify("price", undefined);
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) updateShopify("price", n);
              }}
            />
          </label>
          <label data-field="shopify.quantity">
            Quantity
            <input
              type="number"
              min={1}
              style={{ width: 120, borderColor: invalid["shopify.quantity"] ? "#b91c1c" : undefined }}
              value={sh.quantity ?? 1}
              onChange={(e) => updateShopify("quantity", Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="card" style={{ opacity: 0.75 }}>
        <h2>Depop · Poshmark · Mercari</h2>
        <p style={{ marginTop: 0 }}>
          Automated publishing for these channels is not wired yet. Copy from eBay/Shopify sections or use{" "}
          <Link to="/hybrid">Hybrid</Link> for manual posting.
        </p>
      </div>

      <div className="card">
        <h2>Publish to platforms</h2>
        <p style={{ marginTop: 0, fontSize: "0.9rem", color: "#64748b" }}>
          Only connected integrations can publish. Uncheck any platform to skip it.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {(["ebay", "shopify", "depop", "poshmark", "mercari"] as const).map((p) => {
            const connected = connectedSet.has(p);
            const label = p.charAt(0).toUpperCase() + p.slice(1);
            return (
              <label
                key={p}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  color: connected ? undefined : "#94a3b8",
                }}
              >
                <input
                  type="checkbox"
                  checked={publishTargets[p] ?? false}
                  disabled={!connected || p === "depop" || p === "poshmark" || p === "mercari"}
                  onChange={(e) => setPublishTargets((t) => ({ ...t, [p]: e.target.checked }))}
                />
                {label}
                {!connected && <span>(not connected)</span>}
                {connected && (p === "depop" || p === "poshmark" || p === "mercari") && (
                  <span>(publish N/A)</span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "2rem" }}>
        <button
          type="button"
          className="primary"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate({ navigateAfter: true })}
        >
          {saveMutation.isPending ? "Saving…" : "Save draft & exit"}
        </button>
        <button
          type="button"
          disabled={publishMutation.isPending}
          onClick={() => publishMutation.mutate()}
        >
          {publishMutation.isPending ? "Publishing…" : "Publish draft"}
        </button>
      </div>
    </div>
  );
}
