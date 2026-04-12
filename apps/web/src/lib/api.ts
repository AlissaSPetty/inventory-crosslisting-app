import { supabase } from "./supabase.js";

/** Failed `fetch`; `body` holds JSON when the server returned parseable error payload (e.g. `results` on 502). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch(path: string, init?: RequestInit) {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const hasBody = init?.body != null && init.body !== "";
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      typeof (body as { error?: string }).error === "string"
        ? (body as { error: string }).error
        : res.statusText;
    throw new ApiRequestError(message, res.status, body);
  }
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid JSON response from server");
  }
}
