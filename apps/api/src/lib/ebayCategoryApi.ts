import { normalizeEbayConditionForInventory } from "@inv/shared";
import type { Env } from "../env.js";
import { getEbayApplicationAccessToken } from "./ebayAccessToken.js";
import { localeForEbayMarketplace } from "./ebayLocale.js";

const EBAY_ROOT = (sandbox: boolean) =>
  sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

type TreeCache = { treeId: string; marketplaceId: string };

let categoryTreeCache: TreeCache | null = null;

function restHeaders(token: string, marketplaceId: string, withJsonBody: boolean): Record<string, string> {
  const locale = localeForEbayMarketplace(marketplaceId);
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Accept-Language": locale,
    "Accept-Encoding": "gzip",
  };
  if (withJsonBody) {
    h["Content-Type"] = "application/json";
    h["Content-Language"] = locale;
  }
  return h;
}

async function getCategoryTreeId(env: Env, marketplaceId: string): Promise<string> {
  if (categoryTreeCache?.marketplaceId === marketplaceId) {
    return categoryTreeCache.treeId;
  }
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_ROOT(sandbox);
  const token = await getEbayApplicationAccessToken(env);
  const url = `${base}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplaceId)}`;
  const res = await fetch(url, { headers: restHeaders(token, marketplaceId, false) });
  if (!res.ok) {
    throw new Error(`eBay taxonomy tree id: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as { categoryTreeId?: string };
  const treeId = j.categoryTreeId;
  if (!treeId) throw new Error("eBay taxonomy did not return categoryTreeId");
  categoryTreeCache = { treeId, marketplaceId };
  return treeId;
}

export type CategorySuggestion = { categoryId: string; categoryName: string };

type CategoryTreeNode = {
  category?: { categoryId?: string; categoryName?: string };
  leafCategoryTreeNode?: boolean;
  childCategoryTreeNodes?: CategoryTreeNode[];
};

async function fetchCategorySubtree(
  env: Env,
  marketplaceId: string,
  categoryId: string
): Promise<CategoryTreeNode | null> {
  const cid = categoryId.trim();
  if (!/^\d+$/.test(cid)) return null;
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_ROOT(sandbox);
  const token = await getEbayApplicationAccessToken(env);
  const treeId = await getCategoryTreeId(env, marketplaceId);
  const url = new URL(
    `${base}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree`
  );
  url.searchParams.set("category_id", cid);
  const res = await fetch(url, { headers: restHeaders(token, marketplaceId, false) });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400) {
      throw new Error(`eBay category ID ${cid} is not valid for this marketplace: ${text}`);
    }
    throw new Error(`eBay category lookup: ${res.status} ${text}`);
  }
  const j = (await res.json()) as { categorySubtreeNode?: CategoryTreeNode };
  return j.categorySubtreeNode ?? null;
}

/** Collect listing-eligible leaf categories under a subtree (DFS, capped). */
function collectLeafSuggestionsFromNode(node: CategoryTreeNode, out: CategorySuggestion[], limit: number): void {
  if (node.leafCategoryTreeNode === true) {
    const id = node.category?.categoryId?.trim();
    const name = node.category?.categoryName?.trim();
    if (id && name) out.push({ categoryId: id, categoryName: name });
    return;
  }
  for (const child of node.childCategoryTreeNodes ?? []) {
    if (out.length >= limit) return;
    collectLeafSuggestionsFromNode(child, out, limit);
  }
}

/**
 * Whether a category ID is a leaf (listing-eligible) in the marketplace tree.
 * Parent categories return leaf: false; invalid IDs throw.
 */
export async function fetchCategoryLeafStatus(
  env: Env,
  marketplaceId: string,
  categoryId: string
): Promise<{ leaf: boolean; categoryName?: string }> {
  const node = await fetchCategorySubtree(env, marketplaceId, categoryId);
  if (!node) return { leaf: false };
  const name = node.category?.categoryName?.trim();
  if (node.leafCategoryTreeNode === true) return { leaf: true, categoryName: name };
  return { leaf: false, categoryName: name };
}

/**
 * Leaf category suggestions for a query string (Taxonomy API).
 * eBay may return parent categories; we expand those to leaf IDs so listings can publish.
 * @see https://developer.ebay.com/api-docs/sell/static/metadata/sell-categories.html
 */
export async function fetchCategorySuggestions(
  env: Env,
  marketplaceId: string,
  query: string
): Promise<CategorySuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_ROOT(sandbox);
  const token = await getEbayApplicationAccessToken(env);
  const treeId = await getCategoryTreeId(env, marketplaceId);
  const url = new URL(`${base}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions`);
  url.searchParams.set("q", q);
  const res = await fetch(url, { headers: restHeaders(token, marketplaceId, false) });
  if (!res.ok) {
    throw new Error(`eBay category suggestions: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as {
    categorySuggestions?: { category?: { categoryId?: string; categoryName?: string } }[];
  };
  const raw: CategorySuggestion[] = [];
  for (const row of j.categorySuggestions ?? []) {
    const c = row.category;
    const id = c?.categoryId?.trim();
    const name = c?.categoryName?.trim();
    if (id && name) raw.push({ categoryId: id, categoryName: name });
  }

  const seen = new Set<string>();
  const out: CategorySuggestion[] = [];
  const MAX_LEAVES_PER_BRANCH = 10;
  const MAX_TOTAL = 24;

  for (const row of raw) {
    if (out.length >= MAX_TOTAL) break;
    const subtree = await fetchCategorySubtree(env, marketplaceId, row.categoryId);
    if (!subtree) continue;
    if (subtree.leafCategoryTreeNode === true) {
      if (!seen.has(row.categoryId)) {
        seen.add(row.categoryId);
        out.push({ categoryId: row.categoryId, categoryName: row.categoryName });
      }
      continue;
    }
    const leaves: CategorySuggestion[] = [];
    collectLeafSuggestionsFromNode(subtree, leaves, MAX_LEAVES_PER_BRANCH);
    for (const l of leaves) {
      if (out.length >= MAX_TOTAL) break;
      if (!seen.has(l.categoryId)) {
        seen.add(l.categoryId);
        out.push(l);
      }
    }
  }
  return out;
}

export type ConditionOption = { conditionId: string; label: string };

/**
 * Item condition IDs allowed for a leaf category (Metadata API).
 * @see https://developer.ebay.com/api-docs/sell/metadata/resources/marketplace/methods/getItemConditionPolicies
 */
export async function fetchItemConditionPolicies(
  env: Env,
  marketplaceId: string,
  categoryId: string
): Promise<ConditionOption[]> {
  const cid = categoryId.trim();
  if (!/^\d+$/.test(cid)) return [];
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_ROOT(sandbox);
  const token = await getEbayApplicationAccessToken(env);
  const url = new URL(`${base}/sell/metadata/v1/marketplace/${encodeURIComponent(marketplaceId)}/get_item_condition_policies`);
  url.searchParams.set("filter", `categoryIds:{${cid}}`);
  const res = await fetch(url, { headers: restHeaders(token, marketplaceId, false) });
  if (!res.ok) {
    throw new Error(`eBay item condition policies: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as {
    itemConditionPolicies?: {
      categoryId?: string;
      itemConditions?: { conditionId?: string; conditionDescription?: string }[];
    }[];
  };
  const policies = j.itemConditionPolicies ?? [];
  const policy =
    policies.find((p) => String(p.categoryId) === cid) ?? policies.find((p) => p.itemConditions?.length) ?? policies[0];
  const conditions = policy?.itemConditions ?? [];
  const out: ConditionOption[] = [];
  for (const c of conditions) {
    const rawId = c.conditionId?.trim();
    if (!rawId) continue;
    /** Inventory API expects ConditionEnum strings, not Metadata numeric IDs (e.g. 1000 → NEW). */
    const inventoryEnum = normalizeEbayConditionForInventory(rawId);
    if (!inventoryEnum) continue;
    const label = (c.conditionDescription ?? rawId).trim() || inventoryEnum;
    out.push({ conditionId: inventoryEnum, label });
  }
  return out;
}

/** One aspect row from getItemAspectsForCategory (simplified for UI + publish). */
export type EbayCategoryAspect = {
  localizedAspectName: string;
  aspectRequired: boolean;
  aspectMode: string;
  /** Allowed values when aspectMode is SELECTION_ONLY (localizedValue strings). */
  values: string[];
};

/**
 * Item specifics metadata for a leaf category (Taxonomy API).
 * @see https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getItemAspectsForCategory
 */
export async function fetchItemAspectsForCategory(
  env: Env,
  marketplaceId: string,
  categoryId: string
): Promise<EbayCategoryAspect[]> {
  const cid = categoryId.trim();
  if (!/^\d+$/.test(cid)) return [];
  const sandbox = env.EBAY_SANDBOX !== "false";
  const base = EBAY_ROOT(sandbox);
  const token = await getEbayApplicationAccessToken(env);
  const treeId = await getCategoryTreeId(env, marketplaceId);
  const url = new URL(
    `${base}/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_item_aspects_for_category`
  );
  url.searchParams.set("category_id", cid);
  const res = await fetch(url, { headers: restHeaders(token, marketplaceId, false) });
  if (!res.ok) {
    throw new Error(`eBay item aspects: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as {
    aspects?: {
      localizedAspectName?: string;
      aspectConstraint?: {
        aspectRequired?: boolean;
        aspectMode?: string;
      };
      aspectValues?: { localizedValue?: string }[];
    }[];
  };
  const out: EbayCategoryAspect[] = [];
  for (const a of j.aspects ?? []) {
    const localizedAspectName = a.localizedAspectName?.trim();
    if (!localizedAspectName) continue;
    const values = (a.aspectValues ?? [])
      .map((v) => v.localizedValue?.trim())
      .filter((v): v is string => !!v);
    out.push({
      localizedAspectName,
      aspectRequired: a.aspectConstraint?.aspectRequired === true,
      aspectMode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
      values,
    });
  }
  return out;
}

/** First taxonomy suggestion for AI draft enrichment. */
export async function fetchFirstCategorySuggestion(
  env: Env,
  marketplaceId: string,
  query: string
): Promise<CategorySuggestion | null> {
  const list = await fetchCategorySuggestions(env, marketplaceId, query);
  return list[0] ?? null;
}
