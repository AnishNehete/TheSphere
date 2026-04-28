// _lib/upstream.ts
// Shared utility for proxying requests to the FastAPI backend.

const BACKEND_BASE =
  process.env.SPHERE_BACKEND_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export interface UpstreamOptions {
  path: string;
  method?: "GET" | "POST";
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export async function upstream<T = unknown>(options: UpstreamOptions): Promise<T> {
  const { path, method = "GET", params, body, timeoutMs = 8000 } = options;

  const url = new URL(path, BACKEND_BASE);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Upstream ${method} ${path} returned ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
