import type { ResultsView, SessionView, TestPreview } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export const api = {
  preview: (token: string) => request<TestPreview>("POST", "/api/preview", { token }),
  start: (token: string) => request<{ sessionId: string }>("POST", "/api/start", { token }),
  session: () => request<SessionView>("GET", "/api/session"),
  submit: () => request<{ ok: true }>("POST", "/api/session/submit"),
  results: () => request<ResultsView>("GET", "/api/session/results"),
};
