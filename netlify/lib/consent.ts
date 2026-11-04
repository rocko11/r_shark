// Proof of assent. Courts enforce online terms (and the arbitration clause in them) when the
// business can show the user saw them and agreed. We keep an append-only record per user:
//   consent:<email>  [{ kind, version, at, ip, ua, ...extra }]
import { billing } from "./access.ts";

// Bump whenever terms.html changes materially; users re-accept at their next checkout.
export const TERMS_VERSION = "2026-11-04";

export async function recordConsent(req: Request, email: string, kind: "signin" | "checkout" | "outreach", extra: Record<string, unknown> = {}) {
  const store = billing(), key = `consent:${email}`;
  const list: any[] = ((await store.get(key, { type: "json" }).catch(() => null)) as any[]) || [];
  if (kind === "signin" && list.some(c => c.kind === "signin" && c.version === TERMS_VERSION)) return list;
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  list.push({ kind, version: TERMS_VERSION, at: new Date().toISOString(), ip, ua: (req.headers.get("user-agent") || "").slice(0, 300), ...extra });
  await store.setJSON(key, list.slice(-200));
  return list;
}
