import { describe, expect, it } from "vitest";
import { propagateSaleQuantity } from "./saleSync.js";
import type { Env } from "../env.js";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

/**
 * Minimal chainable Supabase mock covering the exact calls `propagateSaleQuantity` makes.
 * Terminal `single`/`maybeSingle` and direct `await` (thenable) resolve via `resolve(state)`.
 * All inserts are captured in `inserted` for assertions.
 */
function makeSupabaseMock(opts: { soldRow: Row | null; inv: Row | null; others: Row[] }) {
  const inserted: Array<{ table: string; payload: Row }> = [];
  const updated: Array<{ table: string; payload: Row }> = [];

  function resolve(state: {
    table: string;
    op: string;
    isNeq: boolean;
  }): { data: unknown; error: null } {
    if (state.op !== "select") return { data: null, error: null };
    if (state.table === "platform_listings") {
      return state.isNeq
        ? { data: opts.others, error: null }
        : { data: opts.soldRow, error: null };
    }
    if (state.table === "inventory_items") return { data: opts.inv, error: null };
    if (state.table === "integration_credentials") return { data: null, error: null };
    return { data: null, error: null };
  }

  function makeBuilder(table: string) {
    const state = { table, op: "select", isNeq: false };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.neq = () => {
      state.isNeq = true;
      return builder;
    };
    builder.insert = (payload: Row) => {
      state.op = "insert";
      inserted.push({ table, payload });
      return builder;
    };
    builder.update = (payload: Row) => {
      state.op = "update";
      updated.push({ table, payload });
      return builder;
    };
    builder.delete = () => {
      state.op = "delete";
      return builder;
    };
    builder.single = () => Promise.resolve(resolve(state));
    builder.maybeSingle = () => Promise.resolve(resolve(state));
    builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(state)).then(onF, onR);
    return builder;
  }

  const client = { from: (table: string) => makeBuilder(table) };
  return { client: client as unknown as SupabaseClient, inserted, updated };
}

const env = { EBAY_SANDBOX: "true", EBAY_MARKETPLACE_ID: "EBAY_US" } as unknown as Env;

describe("propagateSaleQuantity manual-action branch", () => {
  it("writes manual_action_required (not quantity_sync_error) for a manual_link sibling", async () => {
    const mock = makeSupabaseMock({
      soldRow: { id: "sold-1", inventory_item_id: "inv-1", listed_quantity: 1 },
      inv: { id: "inv-1", quantity_available: 1 },
      others: [
        {
          id: "pl-posh",
          platform: "poshmark",
          external_listing_id: null,
          listed_quantity: 1,
          shop_domain: null,
          listing_url: "https://poshmark.com/listing/abc",
          source: "manual_link",
        },
      ],
    });

    await propagateSaleQuantity(env, mock.client, "user-1", "ebay", "EXT-1", 1);

    const syncEvents = mock.inserted.filter((i) => i.table === "sync_events");
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0].payload.event_type).toBe("manual_action_required");
    expect(syncEvents[0].payload.platform).toBe("poshmark");
    expect((syncEvents[0].payload.payload as Row).listing_url).toBe(
      "https://poshmark.com/listing/abc"
    );
    expect((syncEvents[0].payload.payload as Row).targetQty).toBe(0);

    // No generic error / skip event for the manual row.
    expect(
      syncEvents.some((e) =>
        ["quantity_sync_error", "quantity_sync_skipped"].includes(String(e.payload.event_type))
      )
    ).toBe(false);
  });
});
