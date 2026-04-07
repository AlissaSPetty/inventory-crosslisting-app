import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api.js";

type Connection = {
  platform: string;
  shop_domain: string | null;
  updated_at?: string;
};

type EbayProfile = {
  username?: string;
  userId?: string;
  accountType?: string;
  marketplace?: string;
};

function parseEbayProfile(shop_domain: string | null): EbayProfile | null {
  if (!shop_domain?.startsWith("{")) return null;
  try {
    return JSON.parse(shop_domain) as EbayProfile;
  } catch {
    return null;
  }
}

function formatEbayConnectedAt(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

const DRAFT_PLATFORMS = ["ebay", "shopify", "depop", "poshmark", "mercari"] as const;

const PLATFORM_LABEL: Record<(typeof DRAFT_PLATFORMS)[number], string> = {
  ebay: "eBay",
  shopify: "Shopify",
  depop: "Depop",
  poshmark: "Poshmark",
  mercari: "Mercari",
};

function draftButtonState(
  platform: (typeof DRAFT_PLATFORMS)[number],
  connections: Connection[]
): { enabled: boolean; title: string } {
  if (platform === "depop") {
    return { enabled: false, title: "Depop partner API is not available yet" };
  }
  if (platform === "poshmark" || platform === "mercari") {
    return {
      enabled: false,
      title: "No API connection for this channel — use Hybrid for manual posting",
    };
  }
  const connected = connections.some((c) => c.platform === platform);
  if (!connected) {
    return {
      enabled: false,
      title: `Connect ${PLATFORM_LABEL[platform]} below first`,
    };
  }
  return { enabled: true, title: `Open Inventory to generate AI drafts (${PLATFORM_LABEL[platform]})` };
}

type EbayInventoryLocationsResponse = {
  ebayApiBase: string;
  sandbox: boolean;
  total: number;
  locations: Record<string, unknown>[];
};

export function IntegrationsPage() {
  const [shop, setShop] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const [ebaySuccess, setEbaySuccess] = useState(false);
  const [ebayLocations, setEbayLocations] = useState<EbayInventoryLocationsResponse | null>(null);
  const [ebayLocationsLoading, setEbayLocationsLoading] = useState(false);
  const [ebayLocationsError, setEbayLocationsError] = useState<string | null>(null);
  const [ebayDisconnectConfirmOpen, setEbayDisconnectConfirmOpen] = useState(false);
  const [whName, setWhName] = useState("Primary warehouse");
  const [whPostal, setWhPostal] = useState("");
  const [whCountry, setWhCountry] = useState("US");
  const [whCity, setWhCity] = useState("");
  const [whState, setWhState] = useState("");
  const [whFormError, setWhFormError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, refetch } = useQuery({
    queryKey: ["integrations"],
    queryFn: () =>
      apiFetch("/api/integrations") as Promise<{
        connections: Connection[];
        ebay?: {
          inventoryLocationReady: boolean;
          inventoryLocationDetail?: string;
        };
      }>,
  });

  useEffect(() => {
    if (searchParams.get("ebay") !== "connected") return;
    setEbaySuccess(true);
    void refetch();
    const next = new URLSearchParams(searchParams);
    next.delete("ebay");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refetch]);

  const disconnectEbay = useMutation({
    mutationFn: () => apiFetch("/api/integrations/ebay", { method: "DELETE" }) as Promise<{ ok: boolean }>,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("ebay-"),
      });
      setEbayDisconnectConfirmOpen(false);
      setEbayLocations(null);
      setEbayLocationsError(null);
    },
  });

  const createEbayWarehouse = useMutation({
    mutationFn: (payload: {
      name: string;
      postalCode?: string;
      country: string;
      city?: string;
      stateOrProvince?: string;
    }) =>
      apiFetch("/api/integrations/ebay/inventory-locations", {
        method: "POST",
        body: JSON.stringify(payload),
      }) as Promise<{ ok: boolean; merchantLocationKey: string }>,
    onSuccess: () => {
      setWhFormError(null);
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      void loadEbayInventoryLocations();
    },
    onError: (err) => {
      setWhFormError(err instanceof Error ? err.message : String(err));
    },
  });

  const connections = data?.connections ?? [];
  const ebayMeta = data?.ebay;
  const ebayConnection = connections.find((c) => c.platform === "ebay");
  const ebayProfile = parseEbayProfile(ebayConnection?.shop_domain ?? null);
  const hasEbayDetails =
    !!ebayProfile &&
    Boolean(
      ebayProfile.username?.trim() ||
        ebayProfile.userId ||
        ebayProfile.marketplace ||
        ebayProfile.accountType
    );

  async function connectEbay() {
    const res = (await apiFetch("/api/oauth/ebay/url")) as { url: string };
    window.location.href = res.url;
  }

  async function connectShopify() {
    if (!shop) return;
    const res = (await apiFetch(`/api/oauth/shopify/url?shop=${encodeURIComponent(shop)}`)) as {
      url: string;
    };
    window.location.href = res.url;
  }

  async function loadEbayInventoryLocations() {
    setEbayLocationsLoading(true);
    setEbayLocationsError(null);
    try {
      const res = (await apiFetch("/api/integrations/ebay/inventory-locations")) as EbayInventoryLocationsResponse;
      setEbayLocations(res);
    } catch (e) {
      setEbayLocationsError(e instanceof Error ? e.message : String(e));
      setEbayLocations(null);
    } finally {
      setEbayLocationsLoading(false);
    }
  }

  function submitCreateWarehouse(e: FormEvent) {
    e.preventDefault();
    setWhFormError(null);
    const name = whName.trim() || "Primary warehouse";
    const country = whCountry.trim().toUpperCase();
    const postal = whPostal.trim();
    const city = whCity.trim();
    const st = whState.trim();
    if (country.length !== 2) {
      setWhFormError("Country must be a 2-letter code (e.g. US).");
      return;
    }
    if (postal) {
      createEbayWarehouse.mutate({ name, postalCode: postal, country });
      return;
    }
    if (!city || !st) {
      setWhFormError("Enter a postal code and country, or city + state/province + country (eBay warehouse rules).");
      return;
    }
    createEbayWarehouse.mutate({ name, country, city, stateOrProvince: st });
  }

  return (
    <div>
      <h1>Integrations</h1>
      <div className="card">
        <h2>Add listing drafts</h2>
        <p style={{ marginTop: 0, color: "#64748b", fontSize: "0.95rem" }}>
          Go to <Link to="/inventory">Inventory</Link>, use <strong>Generate drafts</strong> on an item, then edit and
          publish under <Link to="/drafts">Listing drafts</Link>. Buttons below are enabled when that marketplace is
          connected (except hybrid-only channels).
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "stretch" }}>
          {DRAFT_PLATFORMS.map((p) => {
            const { enabled, title } = draftButtonState(p, connections);
            const label = PLATFORM_LABEL[p];
            const text = `Add draft · ${label}`;
            const btnStyle = {
              opacity: enabled ? 1 : 0.45,
              cursor: enabled ? "pointer" : "not-allowed",
            } as const;
            if (enabled) {
              return (
                <Link
                  key={p}
                  to={`/inventory?platform=${encodeURIComponent(p)}`}
                  className="primary"
                  title={title}
                  style={{ ...btnStyle, textDecoration: "none", display: "inline-block" }}
                >
                  {text}
                </Link>
              );
            }
            return (
              <button key={p} type="button" disabled title={title} style={btnStyle}>
                {text}
              </button>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h2>eBay</h2>
        {ebaySuccess && (
          <p
            role="status"
            style={{
              padding: "0.5rem 0.75rem",
              marginBottom: "0.75rem",
              borderRadius: 6,
              background: "#ecfdf5",
              border: "1px solid #6ee7b7",
              color: "#065f46",
            }}
          >
            eBay connected successfully. Your account is linked.
          </p>
        )}
        {ebayConnection && ebayMeta && ebayMeta.inventoryLocationReady === false && (
          <div
            role="alert"
            style={{
              padding: "0.75rem 1rem",
              marginBottom: "0.75rem",
              borderRadius: 6,
              background: "#fff7ed",
              border: "1px solid #fdba74",
              color: "#9a3412",
              fontSize: "0.95rem",
              lineHeight: 1.5,
            }}
          >
            <strong>Inventory location required</strong> — Publishing listings needs at least one{" "}
            <strong>enabled business / inventory location</strong> on eBay (Seller Hub → shipping / warehouse / business
            address). Without it, the listing API cannot assign a ship-from location.
            {ebayMeta.inventoryLocationDetail && (
              <>
                {" "}
                <span style={{ display: "block", marginTop: "0.5rem", fontSize: "0.88rem", opacity: 0.95 }}>
                  {ebayMeta.inventoryLocationDetail}
                </span>
              </>
            )}
          </div>
        )}
        {ebayConnection ? (
          <>
            <p style={{ marginTop: 0 }}>Your eBay seller account is connected.</p>
            {hasEbayDetails && ebayProfile && (
              <dl style={{ margin: "0.75rem 0", display: "grid", gap: "0.35rem 1rem" }}>
                {(ebayProfile.username || ebayProfile.userId) && (
                  <>
                    <dt style={{ fontWeight: 600 }}>Account</dt>
                    <dd style={{ margin: 0 }}>
                      {ebayProfile.username?.trim()
                        ? ebayProfile.username
                        : ebayProfile.userId
                          ? `User ID: ${ebayProfile.userId}`
                          : "—"}
                    </dd>
                  </>
                )}
                {ebayProfile.userId && ebayProfile.username?.trim() && (
                  <>
                    <dt style={{ fontWeight: 600 }}>User ID</dt>
                    <dd style={{ margin: 0, wordBreak: "break-all" }}>{ebayProfile.userId}</dd>
                  </>
                )}
                {ebayProfile.marketplace && (
                  <>
                    <dt style={{ fontWeight: 600 }}>Marketplace</dt>
                    <dd style={{ margin: 0 }}>{ebayProfile.marketplace}</dd>
                  </>
                )}
                {ebayProfile.accountType && (
                  <>
                    <dt style={{ fontWeight: 600 }}>Account type</dt>
                    <dd style={{ margin: 0 }}>{ebayProfile.accountType}</dd>
                  </>
                )}
                {ebayConnection.updated_at && (
                  <>
                    <dt style={{ fontWeight: 600 }}>Connected</dt>
                    <dd style={{ margin: 0 }}>{formatEbayConnectedAt(ebayConnection.updated_at)}</dd>
                  </>
                )}
              </dl>
            )}
            {!hasEbayDetails && ebayConnection.updated_at && (
              <p style={{ color: "#64748b", fontSize: "0.9rem" }}>
                Connected {formatEbayConnectedAt(ebayConnection.updated_at)}.
              </p>
            )}
            <button
              type="button"
              disabled={disconnectEbay.isPending}
              onClick={() => setEbayDisconnectConfirmOpen(true)}
              style={{ marginTop: "0.75rem" }}
            >
              Disconnect eBay
            </button>
            {disconnectEbay.isError && (
              <p className="error" style={{ marginTop: "0.5rem" }}>
                {(disconnectEbay.error as Error).message}
              </p>
            )}
            <p style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#64748b", lineHeight: 1.5 }}>
              eBay’s{" "}
              <a
                href="https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html"
                target="_blank"
                rel="noreferrer"
              >
                Managing inventory locations
              </a>{" "}
              guide describes <code>getInventoryLocations</code> (Inventory API). Load the same list your account
              returns to the API (this app calls <code>GET …/sell/inventory/v1/location</code> with your OAuth token).
            </p>
            <div style={{ marginTop: "0.5rem" }}>
              <button type="button" disabled={ebayLocationsLoading} onClick={() => void loadEbayInventoryLocations()}>
                {ebayLocationsLoading ? "Loading locations…" : "Load inventory locations from eBay"}
              </button>
            </div>
            {ebayLocationsError && (
              <p className="error" style={{ marginTop: "0.5rem" }}>
                {ebayLocationsError}
              </p>
            )}
            {ebayLocations && (
              <div style={{ marginTop: "1rem" }}>
                <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem", color: "#64748b" }}>
                  <strong>API host:</strong> {ebayLocations.ebayApiBase}
                  {ebayLocations.sandbox ? " (sandbox)" : " (production)"} — <strong>total:</strong>{" "}
                  {ebayLocations.total}
                </p>
                {ebayLocations.locations.length === 0 ? (
                  <div style={{ marginTop: "0.75rem" }}>
                    <p style={{ color: "#64748b", margin: "0 0 0.75rem" }}>
                      No inventory locations yet. You can create a default <strong>warehouse</strong> location here
                      (eBay{" "}
                      <a
                        href="https://developer.ebay.com/api-docs/sell/static/inventory/managing-inventory-locations.html#creating"
                        target="_blank"
                        rel="noreferrer"
                      >
                        createInventoryLocation
                      </a>
                      ) or add one in Seller Hub.
                    </p>
                    <form
                      onSubmit={submitCreateWarehouse}
                      style={{
                        display: "grid",
                        gap: "0.65rem",
                        maxWidth: 420,
                        padding: "0.85rem 1rem",
                        background: "#f8fafc",
                        borderRadius: 8,
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.9rem" }}>
                        <span style={{ fontWeight: 600 }}>Location name</span>
                        <input
                          value={whName}
                          onChange={(ev) => setWhName(ev.target.value)}
                          autoComplete="organization"
                          style={{ padding: "0.35rem 0.5rem" }}
                        />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.9rem" }}>
                        <span style={{ fontWeight: 600 }}>Country (ISO)</span>
                        <input
                          value={whCountry}
                          onChange={(ev) => setWhCountry(ev.target.value.toUpperCase().slice(0, 2))}
                          maxLength={2}
                          placeholder="US"
                          style={{ padding: "0.35rem 0.5rem", maxWidth: 80 }}
                        />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.9rem" }}>
                        <span style={{ fontWeight: 600 }}>Postal / ZIP code</span>
                        <input
                          value={whPostal}
                          onChange={(ev) => setWhPostal(ev.target.value)}
                          autoComplete="postal-code"
                          placeholder="e.g. 94103"
                          style={{ padding: "0.35rem 0.5rem" }}
                        />
                      </label>
                      <p style={{ margin: 0, fontSize: "0.82rem", color: "#64748b" }}>
                        Or leave postal code blank and use city + state/province (warehouse minimum per eBay).
                      </p>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.9rem", flex: "1 1 140px" }}>
                          <span style={{ fontWeight: 600 }}>City</span>
                          <input
                            value={whCity}
                            onChange={(ev) => setWhCity(ev.target.value)}
                            autoComplete="address-level2"
                            style={{ padding: "0.35rem 0.5rem" }}
                          />
                        </label>
                        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.9rem", flex: "1 1 120px" }}>
                          <span style={{ fontWeight: 600 }}>State / province</span>
                          <input
                            value={whState}
                            onChange={(ev) => setWhState(ev.target.value)}
                            autoComplete="address-level1"
                            style={{ padding: "0.35rem 0.5rem" }}
                          />
                        </label>
                      </div>
                      {whFormError && <p className="error" style={{ margin: 0 }}>{whFormError}</p>}
                      <div>
                        <button className="primary" type="submit" disabled={createEbayWarehouse.isPending}>
                          {createEbayWarehouse.isPending ? "Creating…" : "Create warehouse location on eBay"}
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "0.9rem",
                      }}
                    >
                      <thead>
                        <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                          <th style={{ padding: "0.4rem 0.5rem" }}>merchantLocationKey</th>
                          <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                          <th style={{ padding: "0.4rem 0.5rem" }}>Name</th>
                          <th style={{ padding: "0.4rem 0.5rem" }}>Types</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ebayLocations.locations.map((loc, i) => {
                          const key = loc.merchantLocationKey != null ? String(loc.merchantLocationKey) : "—";
                          const status =
                            loc.merchantLocationStatus != null ? String(loc.merchantLocationStatus) : "—";
                          const name = loc.name != null ? String(loc.name) : "—";
                          const types = Array.isArray(loc.locationTypes)
                            ? (loc.locationTypes as unknown[]).map(String).join(", ")
                            : "—";
                          return (
                            <tr key={`${key}-${i}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "0.4rem 0.5rem", wordBreak: "break-all" }}>{key}</td>
                              <td style={{ padding: "0.4rem 0.5rem" }}>{status}</td>
                              <td style={{ padding: "0.4rem 0.5rem" }}>{name}</td>
                              <td style={{ padding: "0.4rem 0.5rem" }}>{types}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <details style={{ marginTop: "0.75rem" }}>
                  <summary style={{ cursor: "pointer", fontSize: "0.9rem", color: "#64748b" }}>
                    Raw JSON (full API response objects)
                  </summary>
                  <pre
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.75rem",
                      background: "#f8fafc",
                      borderRadius: 6,
                      fontSize: "0.78rem",
                      overflow: "auto",
                      maxHeight: 320,
                    }}
                  >
                    {JSON.stringify(ebayLocations.locations, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </>
        ) : (
          <>
            <p>OAuth with your eBay developer app (redirect URL must match API callback).</p>
            <button className="primary" type="button" onClick={connectEbay}>
              Connect eBay
            </button>
          </>
        )}
      </div>
      <div className="card">
        <h2>Shopify</h2>
        <input
          placeholder="your-store.myshopify.com"
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          style={{ width: "100%", maxWidth: 360 }}
        />
        <div style={{ marginTop: "0.5rem" }}>
          <button className="primary" type="button" onClick={connectShopify}>
            Connect Shopify
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Depop</h2>
        <p>
          <strong>Blocked</strong> until partner API credentials are available.
        </p>
      </div>
      <div className="card">
        <h2>Connected</h2>
        <button type="button" onClick={() => refetch()}>
          Refresh
        </button>
        <ul>
          {connections.map((c) => (
            <li key={`${c.platform}-${c.shop_domain ?? ""}`}>{c.platform}</li>
          ))}
        </ul>
      </div>

      {ebayDisconnectConfirmOpen && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !disconnectEbay.isPending) {
              setEbayDisconnectConfirmOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ebay-disconnect-title"
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: "1.25rem 1.35rem",
              maxWidth: 440,
              width: "100%",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="ebay-disconnect-title" style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>
              Disconnect eBay?
            </h2>
            <p style={{ margin: "0 0 1.1rem", color: "#475569", fontSize: "0.95rem", lineHeight: 1.5 }}>
              This removes the stored eBay connection from this app (OAuth tokens in your account’s integration
              credentials). You can connect again anytime.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={disconnectEbay.isPending}
                onClick={() => setEbayDisconnectConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={disconnectEbay.isPending}
                onClick={() => disconnectEbay.mutate()}
              >
                {disconnectEbay.isPending ? "Disconnecting…" : "Yes, disconnect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
