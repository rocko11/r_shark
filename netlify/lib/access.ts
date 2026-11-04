// Who is calling, what plan they're on, and what they may use — enforced server-side.
//
// Auth: the browser holds a Netlify Identity (GoTrue) access token from Google sign-in and sends it
// as the `rs_token` cookie (SameSite=Lax, so it rides along with same-site fetches, <img> loads and
// downloads) or an Authorization: Bearer header. We verify it against the site's own Identity
// endpoint and cache the result briefly.
//
// Billing state lives in Netlify Blobs (store "billing"), written by the Stripe webhook:
//   sub:<email>     { plan, interval, status, customer, subscription, current_period_end, seats }
//   member:<email>  { owner: <team owner email> }        (Team plan seats)
//   usage:<email>:<YYYY-MM>  { reports, skiptrace }
import { getStore } from "@netlify/blobs";

export const OWNER_EMAILS = new Set(["roeipaz@gmail.com"]);

export type Plan = "starter" | "pro" | "team" | "owner";
export interface PlanDef { name: string; price_m: number; price_y: number; reports: number | null; skiptrace: number; seats: number;
  features: { hunt: boolean; lists: boolean; csv: boolean; pdf: boolean; skiptrace: boolean; pacer: boolean } }
export const PLANS: Record<Exclude<Plan, "owner">, PlanDef> = {
  starter: { name: "Starter", price_m: 49, price_y: 490, reports: 25, skiptrace: 0, seats: 1,
    features: { hunt: true, lists: false, csv: false, pdf: true, skiptrace: false, pacer: false } },
  pro: { name: "Pro", price_m: 149, price_y: 1490, reports: null, skiptrace: 50, seats: 1,
    features: { hunt: true, lists: true, csv: true, pdf: true, skiptrace: true, pacer: false } },
  team: { name: "Team", price_m: 399, price_y: 3990, reports: null, skiptrace: 250, seats: 5,
    features: { hunt: true, lists: true, csv: true, pdf: true, skiptrace: true, pacer: false } },
};
const OWNER_DEF: PlanDef = { name: "Owner", price_m: 0, price_y: 0, reports: null, skiptrace: 100000, seats: 99,
  features: { hunt: true, lists: true, csv: true, pdf: true, skiptrace: true, pacer: true } };

export const billing = () => getStore({ name: "billing", consistency: "strong" });
const month = () => new Date().toISOString().slice(0, 7);
const norm = (e: string) => String(e || "").trim().toLowerCase();

/* ---------------- token → user ---------------- */
const tokenCache = new Map<string, { email: string; id: string; exp: number }>();
function readToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  const c = req.headers.get("cookie") || "";
  const m = c.match(/(?:^|;\s*)rs_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function jwtExp(t: string): number {
  try { return JSON.parse(Buffer.from(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).exp * 1000; } catch { return 0; }
}
export async function getUser(req: Request): Promise<{ email: string; id: string } | null> {
  const token = readToken(req);
  if (!token) return null;
  const exp = jwtExp(token);
  if (exp && exp < Date.now()) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now()) return { email: hit.email, id: hit.id };
  // Same Identity instance answers on the custom domain and on *.netlify.app.
  const bases = [...new Set([new URL(req.url).origin, process.env.URL, "https://rshark.netlify.app"].filter(Boolean))] as string[];
  let u: any = null;
  for (const base of bases) {
    const r = await fetch(`${base}/.netlify/identity/user`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (r && r.ok) { u = await r.json().catch(() => null); break; }
    if (r && r.status === 401) break; // token rejected — don't keep trying
  }
  if (!u?.email) return null;
  const user = { email: norm(u.email), id: String(u.id || "") };
  tokenCache.set(token, { ...user, exp: Math.min(exp || Date.now() + 300_000, Date.now() + 300_000) });
  if (tokenCache.size > 2000) tokenCache.clear();
  return user;
}

/* ---------------- entitlement ---------------- */
export interface Entitlement {
  email: string; plan: Plan | null; status: string; active: boolean; def: PlanDef | null;
  account: string;           // whose subscription pays (team owner for members)
  sub?: any; member_of?: string | null;
  teaser?: boolean;          // signed in, no plan: gets a scrambled, blurred preview
}
const ACTIVE = new Set(["active", "trialing", "past_due"]); // past_due: Stripe is retrying — keep access during dunning
export async function entitlement(email: string): Promise<Entitlement> {
  const e = norm(email);
  if (OWNER_EMAILS.has(e)) return { email: e, plan: "owner", status: "active", active: true, def: OWNER_DEF, account: e };
  const store = billing();
  let sub: any = await store.get(`sub:${e}`, { type: "json" }).catch(() => null);
  let account = e, member_of: string | null = null;
  if (!sub || !ACTIVE.has(sub.status)) {
    const mem: any = await store.get(`member:${e}`, { type: "json" }).catch(() => null);
    if (mem?.owner) {
      const os: any = await store.get(`sub:${norm(mem.owner)}`, { type: "json" }).catch(() => null);
      if (os && os.plan === "team" && ACTIVE.has(os.status) && (os.members || []).includes(e)) { sub = os; account = norm(mem.owner); member_of = account; }
    }
  }
  const plan = (sub?.plan as Plan) || null;
  const active = !!sub && ACTIVE.has(sub.status) && !!plan && plan in PLANS;
  return { email: e, plan: active ? plan : null, status: sub?.status || "none", active, def: active ? PLANS[plan as keyof typeof PLANS] : null, account, sub, member_of };
}

/* ---------------- usage ---------------- */
export async function getUsage(account: string) {
  const u: any = await billing().get(`usage:${norm(account)}:${month()}`, { type: "json" }).catch(() => null);
  return { month: month(), reports: u?.reports || 0, skiptrace: u?.skiptrace || 0, seen: u?.seen || [] };
}
// Count a property report. Re-opening the same property in the same month is free.
async function bump(account: string, field: "reports" | "skiptrace", n: number, key?: string) {
  const store = billing(); const k = `usage:${norm(account)}:${month()}`;
  const u: any = (await store.get(k, { type: "json" }).catch(() => null)) || { reports: 0, skiptrace: 0, seen: [] };
  if (key && field === "reports") { if ((u.seen || []).includes(key)) return u; u.seen = [...(u.seen || []), key].slice(-500); }
  u[field] = (u[field] || 0) + n;
  await store.setJSON(k, u);
  return u;
}

/* ---------------- gate for API functions ---------------- */
const json = (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export type Feature = "basic" | "report" | "hunt" | "lists" | "csv" | "skiptrace" | "pacer";
// Returns the entitlement, or a Response to send back (401 not signed in, 402 needs a plan / upgrade / limit hit).
// Free preview allowance (signed in, no plan): generous, but stops anyone hammering the APIs.
export const FREE_PREVIEW_REPORTS = 100;
export async function gate(req: Request, feature: Feature, opts: { reportKey?: string; credits?: number; preview?: boolean } = {}): Promise<Entitlement | Response> {
  const user = await getUser(req);
  if (!user) return json({ error: "Sign in to use R Shark.", code: "auth_required" }, 401);
  const ent = await entitlement(user.email);
  if (!ent.active || !ent.def) {
    if (opts.preview) {
      if (feature === "report") {
        const u = await getUsage(ent.email);
        if (!(opts.reportKey && u.seen.includes(opts.reportKey)) && u.reports >= FREE_PREVIEW_REPORTS)
          return json({ error: `You've previewed ${FREE_PREVIEW_REPORTS} properties this month. Subscribe to keep going — and unlock everything in them.`, code: "subscription_required" }, 402);
      }
      return { ...ent, teaser: true };
    }
    return json({ error: "An active R Shark subscription is required.", code: "subscription_required", plan: null }, 402);
  }
  const f = ent.def.features;
  if (feature === "pacer" && !f.pacer) return json({ error: "Not available on your plan.", code: "upgrade_required" }, 402);
  if ((feature === "lists" && !f.lists) || (feature === "csv" && !f.csv))
    return json({ error: `This list is part of the Pro plan. You're on ${ent.def.name}.`, code: "upgrade_required", needs: "pro", plan: ent.plan }, 402);
  if (feature === "skiptrace") {
    if (!f.skiptrace) return json({ error: "Owner phone / email lookups are part of the Pro plan.", code: "upgrade_required", needs: "pro", plan: ent.plan }, 402);
    const used = (await getUsage(ent.account)).skiptrace, need = opts.credits || 1;
    if (used + need > ent.def.skiptrace) return json({ error: `You've used ${used} of ${ent.def.skiptrace} owner lookups this month.`, code: "limit_reached", plan: ent.plan }, 402);
    await bump(ent.account, "skiptrace", need);
  }
  if (feature === "report" && ent.def.reports != null) {
    const u = await getUsage(ent.account);
    const already = opts.reportKey && u.seen.includes(opts.reportKey);
    if (!already && u.reports >= ent.def.reports)
      return json({ error: `You've used all ${ent.def.reports} property reports in your ${ent.def.name} plan this month.`, code: "limit_reached", needs: "pro", plan: ent.plan, usage: u.reports, limit: ent.def.reports }, 402);
  }
  return ent;
}
// Call after a report was actually delivered (found), so failed lookups don't use up the allowance.
export async function recordReport(ent: Entitlement, reportKey: string) {
  if (ent.teaser) { await bump(ent.email, "reports", 1, reportKey).catch(() => {}); return; }
  if (!ent.def || ent.def.reports == null) return;
  await bump(ent.account, "reports", 1, reportKey).catch(() => {});
}
