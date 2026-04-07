import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";

function formatConnectionSuffix(platform: string, shop_domain?: string | null): string {
  if (!shop_domain) return "";
  if (platform === "ebay" && shop_domain.startsWith("{")) {
    try {
      const p = JSON.parse(shop_domain) as { username?: string; userId?: string };
      const label = p.username?.trim() || p.userId;
      return label ? ` (${label})` : "";
    } catch {
      return ` (${shop_domain})`;
    }
  }
  return ` (${shop_domain})`;
}

export function Dashboard() {
  const { data } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => apiFetch("/api/integrations") as Promise<{ connections: unknown[] }>,
  });

  return (
    <div>
      <h1>Dashboard</h1>
      <p>Multi-marketplace inventory — connect channels under Integrations, manage stock in Inventory.</p>
      <div className="card">
        <h2>Connections</h2>
        {data?.connections?.length ? (
          <ul>
            {(data.connections as { platform: string; shop_domain?: string }[]).map((c) => (
              <li key={`${c.platform}-${c.shop_domain ?? ""}`}>
                {c.platform}
                {formatConnectionSuffix(c.platform, c.shop_domain)}
              </li>
            ))}
          </ul>
        ) : (
          <p>No integrations connected yet.</p>
        )}
      </div>
    </div>
  );
}
