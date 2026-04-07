import {
  EBAY_DESCRIPTION_MAX,
  EBAY_TITLE_MAX,
  SHOPIFY_TITLE_MAX,
  EBAY_CONDITIONS,
} from "./draftEditor.js";
import { normalizeEbayConditionForInventory } from "./ebayConditionNormalize.js";

/** eBay-only listing details; other marketplaces may reuse similar shapes later. */
export type EbayListingDetails = {
  /** Display / search hint; leaf category id stays in categoryId */
  category?: string;
  costOfGoods?: number;
  sku?: string;
  color?: string;
  /** eBay item specifics: localized aspect name (e.g. Brand) → value; keys must match Taxonomy getItemAspectsForCategory */
  itemAspects?: Record<string, string>;
};

/** eBay business policies + package (optional overrides at publish). */
export type EbayShippingDraft = {
  fulfillmentPolicyId?: string | null;
  returnPolicyId?: string | null;
  paymentPolicyId?: string | null;
  packageWeightLbs?: number | null;
  packageWeightOz?: number | null;
  packageLengthIn?: number | null;
  packageWidthIn?: number | null;
  packageHeightIn?: number | null;
  /** null = unset; true/false = irregular / not irregular */
  irregularPackage?: boolean | null;
};

/** eBay pricing & Best Offer (list price remains `ebay.price`). */
export type EbayPricingDraft = {
  bestOfferEnabled?: boolean | null;
  /** Maps to eBay auto-decline: offers at or below this USD amount are declined */
  minimumOfferUsd?: number | null;
  autoAcceptUsd?: number | null;
};

export type DraftEditorPayload = {
  photoIds?: string[];
  ebay?: {
    title?: string;
    description?: string;
    price?: number;
    quantity?: number;
    condition?: string;
    categoryId?: string;
    listing?: EbayListingDetails;
    shipping?: EbayShippingDraft;
    pricing?: EbayPricingDraft;
  };
  shopify?: {
    title?: string;
    bodyHtml?: string;
    price?: number;
    quantity?: number;
  };
  depop?: Record<string, unknown>;
  poshmark?: Record<string, unknown>;
  mercari?: Record<string, unknown>;
};

export type ValidationIssue = { field: string; message: string };

function ebayIssues(
  e: DraftEditorPayload["ebay"],
  photoIds: string[] | undefined,
  requiredAspectNames?: string[]
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!e) {
    out.push({ field: "ebay.title", message: "eBay section is missing" });
    return out;
  }
  const title = (e.title ?? "").trim();
  if (!title) out.push({ field: "ebay.title", message: "Title is required" });
  else if (title.length > EBAY_TITLE_MAX) {
    out.push({ field: "ebay.title", message: `Title must be at most ${EBAY_TITLE_MAX} characters` });
  }
  const desc = (e.description ?? "").trim();
  if (!desc) out.push({ field: "ebay.description", message: "Description is required" });
  else if (desc.length > EBAY_DESCRIPTION_MAX) {
    out.push({
      field: "ebay.description",
      message: `Description must be at most ${EBAY_DESCRIPTION_MAX} characters`,
    });
  }
  if (e.price == null || Number.isNaN(Number(e.price)) || Number(e.price) <= 0) {
    out.push({ field: "ebay.price", message: "Price must be greater than 0" });
  }
  const qty = e.quantity ?? 0;
  if (!Number.isInteger(qty) || qty < 1) {
    out.push({ field: "ebay.quantity", message: "Quantity must be a whole number ≥ 1" });
  }
  const cond = normalizeEbayConditionForInventory(e.condition ?? "");
  if (!cond || !EBAY_CONDITIONS.includes(cond as (typeof EBAY_CONDITIONS)[number])) {
    out.push({ field: "ebay.condition", message: "Select a valid condition" });
  }
  if (!photoIds?.length) {
    out.push({ field: "photos", message: "At least one photo is required for eBay" });
  }

  const pr = e.pricing;
  const bin = Number(e.price);
  if (pr?.bestOfferEnabled === true) {
    const min = pr.minimumOfferUsd;
    const acc = pr.autoAcceptUsd;
    if (min != null && !Number.isNaN(Number(min)) && acc != null && !Number.isNaN(Number(acc))) {
      if (Number(min) >= Number(acc)) {
        out.push({
          field: "ebay.pricing.minimumOfferUsd",
          message: "Minimum offer must be less than auto-accept threshold",
        });
      }
    }
    if (acc != null && !Number.isNaN(Number(acc)) && Number(acc) >= bin) {
      out.push({
        field: "ebay.pricing.autoAcceptUsd",
        message: "Auto-accept must be below your list price",
      });
    }
    if (min != null && !Number.isNaN(Number(min)) && Number(min) >= bin) {
      out.push({
        field: "ebay.pricing.minimumOfferUsd",
        message: "Decline-below amount must be less than list price",
      });
    }
  }

  if (requiredAspectNames?.length) {
    const ia = e.listing?.itemAspects ?? {};
    for (const name of requiredAspectNames) {
      const v = ia[name]?.trim();
      if (!v) {
        out.push({
          field: `ebay.itemAspect.${name}`,
          message: `${name} is required for this eBay category`,
        });
      }
    }
  }

  return out;
}

function shopifyIssues(s: DraftEditorPayload["shopify"]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!s) {
    out.push({ field: "shopify.title", message: "Shopify section is missing" });
    return out;
  }
  const title = (s.title ?? "").trim();
  if (!title) out.push({ field: "shopify.title", message: "Title is required" });
  else if (title.length > SHOPIFY_TITLE_MAX) {
    out.push({ field: "shopify.title", message: `Title must be at most ${SHOPIFY_TITLE_MAX} characters` });
  }
  if (s.price == null || Number.isNaN(Number(s.price)) || Number(s.price) <= 0) {
    out.push({ field: "shopify.price", message: "Price must be greater than 0" });
  }
  return out;
}

export type ValidateDraftEditorOptions = {
  /** Localized aspect names required for the selected eBay leaf category (from Taxonomy). */
  ebayRequiredAspectNames?: string[];
};

/** Validate editor payload for saving or publishing selected platforms. */
export function validateDraftEditor(
  editor: DraftEditorPayload | undefined,
  platforms: string[],
  options?: ValidateDraftEditorOptions
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!editor) {
    issues.push({ field: "editor", message: "Draft data is missing" });
    return issues;
  }
  const photoIds = editor.photoIds;
  for (const p of platforms) {
    if (p === "ebay") {
      issues.push(
        ...ebayIssues(editor.ebay, photoIds, options?.ebayRequiredAspectNames)
      );
    }
    if (p === "shopify") issues.push(...shopifyIssues(editor.shopify));
    if (p === "depop" || p === "poshmark" || p === "mercari") {
      issues.push({
        field: `${p}.blocked`,
        message: "Automated publishing is not available for this channel yet",
      });
    }
  }
  return issues;
}
