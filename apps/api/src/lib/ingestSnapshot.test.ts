import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedListing } from "./adapters/types.js";
import { ingestListingSnapshot } from "./ingestSnapshot.js";

type Row = Record<string, unknown>;
type Filter =
  | { type: "eq"; col: string; val: unknown }
  | { type: "in"; col: string; val: unknown[] }
  | { type: "lt"; col: string; val: unknown };

/**
 * In-memory `platform_listings` + `sync_events` fake supporting exactly the query
 * shapes `ingestListingSnapshot` issues: count/head selects, eq/in filters,
 * maybeSingle lookups, insert().select().single(), update().eq(), delete().eq().
 */
function makeDb(seed: Row[] = []) {
  let idc = 1;
  const rows: Row[] = seed.map((r) => ({ ...r }));
  const syncEvents: Row[] = [];

  const match = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      if (f.type === "eq") return row[f.col] === f.val;
      if (f.type === "in") return f.val.includes(row[f.col]);
      return true; // `lt` (event trim) — ignored for matching
    });

  function makeBuilder(table: string) {
    const st: {
      table: string;
      op: "select" | "insert" | "update" | "delete";
      filters: Filter[];
      payload: Row | Row[] | null;
      count: boolean;
      mutated: boolean;
      insertedIds?: string[];
    } = { table, op: "select", filters: [], payload: null, count: false, mutated: false };

    const b: Record<string, unknown> = {};
    b.select = (_cols: string, opts?: { head?: boolean }) => {
      if (opts?.head) st.count = true;
      return b;
    };
    b.eq = (col: string, val: unknown) => (st.filters.push({ type: "eq", col, val }), b);
    b.in = (col: string, val: unknown[]) => (st.filters.push({ type: "in", col, val }), b);
    b.lt = (col: string, val: unknown) => (st.filters.push({ type: "lt", col, val }), b);
    b.order = () => b;
    b.limit = () => b;
    b.range = () => b;
    b.insert = (payload: Row | Row[]) => ((st.op = "insert"), (st.payload = payload), b);
    b.update = (payload: Row) => ((st.op = "update"), (st.payload = payload), b);
    b.delete = () => ((st.op = "delete"), b);

    function run(): { data: unknown; count?: number; error: null } {
      if (st.op === "insert") {
        if (!st.mutated) {
          st.mutated = true;
          const payloads = Array.isArray(st.payload) ? st.payload : [st.payload ?? {}];
          if (st.table === "platform_listings") {
            st.insertedIds = payloads.map((p) => {
              const row = { id: `row-${idc++}`, ...p };
              rows.push(row);
              return row.id as string;
            });
          } else if (st.table === "sync_events") {
            for (const p of payloads) syncEvents.push(p);
          }
        }
        return st.table === "platform_listings"
          ? { data: (st.insertedIds ?? []).map((id) => ({ id })), error: null }
          : { data: null, error: null };
      }
      if (st.op === "update") {
        if (!st.mutated) {
          st.mutated = true;
          for (const r of rows) if (match(r, st.filters)) Object.assign(r, st.payload ?? {});
        }
        return { data: null, error: null };
      }
      if (st.op === "delete") {
        if (!st.mutated) {
          st.mutated = true;
          if (st.table === "platform_listings") {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (match(rows[i], st.filters)) rows.splice(i, 1);
            }
          }
        }
        return { data: null, error: null };
      }
      const matched = st.table === "platform_listings" ? rows.filter((r) => match(r, st.filters)) : [];
      if (st.count) return { data: null, count: matched.length, error: null };
      return { data: matched, error: null };
    }

    b.single = () => Promise.resolve(run());
    b.maybeSingle = () => {
      const res = run();
      return Promise.resolve(
        Array.isArray(res.data) ? { data: res.data[0] ?? null, error: null } : res
      );
    };
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onF, onR);
    return b;
  }

  return {
    client: { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient,
    rows,
    syncEvents,
  };
}

const USER = "user-1";
const PLATFORM = "poshmark" as const;

function seedRow(extId: string, over: Row = {}): Row {
  return {
    id: `seed-${extId}`,
    user_id: USER,
    platform: PLATFORM,
    external_listing_id: extId,
    listing_title: `Title ${extId}`,
    listing_image_url: null,
    status: "pending_link",
    listed_quantity: 1,
    source: "sync_fetch",
    inventory_item_id: null,
    metadata: {},
    ...over,
  };
}

function listing(extId: string, over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    externalListingId: extId,
    title: `Title ${extId}`,
    quantity: 1,
    status: "available",
    ...over,
  };
}

describe("ingestListingSnapshot", () => {
  it("inserts new rows and maps sold → status 'sold' (kept, not live)", async () => {
    const db = makeDb();
    const res = await ingestListingSnapshot(
      db.client,
      USER,
      PLATFORM,
      [listing("A"), listing("B"), listing("C", { status: "sold" })],
      { prune: true, complete: true }
    );
    expect(db.rows).toHaveLength(3);
    expect(db.rows.find((r) => r.external_listing_id === "A")?.status).toBe("pending_link");
    expect(db.rows.find((r) => r.external_listing_id === "C")?.status).toBe("sold");
    expect(res.importedOrUpdated).toBe(2); // A + B live; C sold
    expect(res.pruned).toBe(0);
  });

  it("stores priceCents in metadata (no price column)", async () => {
    const db = makeDb();
    await ingestListingSnapshot(
      db.client,
      USER,
      PLATFORM,
      [listing("A", { metadata: { priceCents: 2599, brand: "Nike" } })],
      { prune: true, complete: true }
    );
    expect(db.rows[0].metadata).toMatchObject({ priceCents: 2599, brand: "Nike" });
  });

  it("prunes rows absent from a complete snapshot", async () => {
    const db = makeDb([seedRow("A"), seedRow("B")]);
    const res = await ingestListingSnapshot(db.client, USER, PLATFORM, [listing("A")], {
      prune: true,
      complete: true,
    });
    expect(db.rows.map((r) => r.external_listing_id)).toEqual(["A"]);
    expect(res.pruned).toBe(1);
  });

  it("keeps a sold item in the snapshot instead of pruning it", async () => {
    const db = makeDb([seedRow("A"), seedRow("B")]);
    await ingestListingSnapshot(
      db.client,
      USER,
      PLATFORM,
      [listing("A"), listing("B", { status: "sold" })],
      { prune: true, complete: true }
    );
    expect(db.rows).toHaveLength(2);
    expect(db.rows.find((r) => r.external_listing_id === "B")?.status).toBe("sold");
  });

  it("does NOT prune when the snapshot is incomplete", async () => {
    const db = makeDb([seedRow("A"), seedRow("B")]);
    const res = await ingestListingSnapshot(db.client, USER, PLATFORM, [listing("A")], {
      prune: true,
      complete: false,
    });
    expect(db.rows).toHaveLength(2);
    expect(res.pruneSkipped).toBe(true);
    expect(res.pruneSkippedReason).toBe("snapshot_incomplete");
  });

  it("does NOT prune on an empty snapshot", async () => {
    const db = makeDb([seedRow("A")]);
    const res = await ingestListingSnapshot(db.client, USER, PLATFORM, [], {
      prune: true,
      complete: true,
    });
    expect(db.rows).toHaveLength(1);
    expect(res.pruneSkippedReason).toBe("empty_snapshot");
  });

  it("does NOT prune on an implausible collapse of a large closet", async () => {
    const seed = Array.from({ length: 10 }, (_, i) => seedRow(`X${i}`));
    const db = makeDb(seed);
    const res = await ingestListingSnapshot(db.client, USER, PLATFORM, [listing("X0")], {
      prune: true,
      complete: true,
    });
    expect(db.rows).toHaveLength(10);
    expect(res.pruneSkippedReason).toBe("implausible_drop");
  });

  it("refreshes quantity on a manual_link row but never clobbers its title/image", async () => {
    const db = makeDb([
      seedRow("M", {
        source: "manual_link",
        listing_title: "Hand-curated title",
        listing_image_url: "hand.jpg",
        status: "active",
      }),
    ]);
    await ingestListingSnapshot(
      db.client,
      USER,
      PLATFORM,
      [listing("M", { title: "Scraped title", quantity: 4, imageUrl: "scraped.jpg" })],
      { prune: true, complete: true }
    );
    const row = db.rows.find((r) => r.external_listing_id === "M");
    expect(row?.listed_quantity).toBe(4);
    expect(row?.listing_title).toBe("Hand-curated title");
    expect(row?.listing_image_url).toBe("hand.jpg");
  });
});
