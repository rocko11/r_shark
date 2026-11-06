// Owner-only admin API: every registered user, their plan, usage and billing — and the controls.
//   GET  /.netlify/functions/admin            -> { users, totals }
//   POST /.netlify/functions/admin  { action, email, ... }
// Lambda-style handler on purpose: only these get Netlify Identity's admin token
// (context.clientContext.identity), which is needed to list and delete Identity users.
import { connectLambda } from "@netlify/blobs";
import { getUser, billing, OWNER_EMAILS, PLANS, saveGrant, deleteGrant, getUsage } from "../lib/access.ts";
import { stripe, stripeMode } from "../lib/stripe.ts";

const month = () => new Date().toISOString().slice(0, 7);
const norm = (e: any) => String(e || "").trim().toLowerCase();
const out = (statusCode: number, body: unknown) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

async function identityUsers(identity: any) {
  if (!identity?.url || !identity?.token) return { users: [] as any[], error: "Identity admin token unavailable" };
  const users: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${identity.url}/admin/users?per_page=500&page=${page}`, { headers: { Authorization: `Bearer ${identity.token}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { users, error: `Identity ${r.status}` };
    const j: any = await r.json();
    const batch = j.users || [];
    users.push(...batch);
    if (batch.length < 500) break;
  }
  return { users, error: null };
}

async function readAll(prefix: string) {
  const store = billing();
  const { blobs } = await store.list({ prefix });
  const vals = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
  const m: Record<string, any> = {};
  blobs.forEach((b, i) => { m[b.key.slice(prefix.length).split(":")[0]] = vals[i] ?? true; });
  return m;
}

export const handler = async (event: any, context: any) => {
  connectLambda(event);
  const req = new Request(event.rawUrl || "https://rshark.net/.netlify/functions/admin", { headers: event.headers });
  const me = await getUser(req);
  if (!me) return out(401, { error: "Sign in first." });
  if (!OWNER_EMAILS.has(me.email)) return out(403, { error: "Admins only." });
  const identity = context?.clientContext?.identity;
  const store = billing();

  if (event.httpMethod === "GET") {
    const [{ users, error }, subs, grants, members, blocks, seen] = await Promise.all([
      identityUsers(identity), readAll("sub:"), readAll("grant:"), readAll("member:"), readAll("block:"), readAll("seen:")]);
    const { blobs: usageKeys } = await store.list({ prefix: "usage:" });
    const m = month(), usage: Record<string, any> = {};
    await Promise.all(usageKeys.filter(b => b.key.endsWith(":" + m)).map(async b => {
      usage[b.key.slice(6, -(m.length + 1))] = await store.get(b.key, { type: "json" }).catch(() => null);
    }));
    const byEmail = new Map<string, any>();
    for (const u of users) byEmail.set(norm(u.email), {
      email: norm(u.email), id: u.id, name: u.user_metadata?.full_name || u.user_metadata?.name || null,
      avatar: u.user_metadata?.avatar_url || null, provider: u.app_metadata?.provider || null,
      created: u.created_at || null, confirmed: u.confirmed_at || null, identity: true });
    // Anyone with billing records but no Identity row (e.g. deleted from Identity) still shows.
    for (const e of new Set([...Object.keys(subs), ...Object.keys(grants), ...Object.keys(seen)]))
      if (!byEmail.has(e)) byEmail.set(e, { email: e, id: null, name: seen[e]?.name || null, identity: false });
    const now = Date.now();
    const rows = [...byEmail.values()].map(u => {
      const s = subs[u.email], g = grants[u.email], mem = members[u.email];
      const g_active = g && !(g.expires && new Date(g.expires).getTime() < now);
      const paying = s && ["active", "trialing", "past_due"].includes(s.status);
      const access = OWNER_EMAILS.has(u.email) ? "owner" : blocks[u.email] ? "blocked" : paying ? s.plan : g_active ? `${g.plan} (free)` : mem ? "team member" : "preview";
      const mrr = paying && s.plan in PLANS ? (s.interval === "year" ? PLANS[s.plan as keyof typeof PLANS].price_y / 12 : PLANS[s.plan as keyof typeof PLANS].price_m) : 0;
      return { ...u, access, blocked: !!blocks[u.email], block: blocks[u.email] || null,
        sub: s || null, grant: g || null, grant_active: !!g_active, team_owner: mem?.owner || null,
        usage: usage[u.email] ? { reports: usage[u.email].reports || 0, skiptrace: usage[u.email].skiptrace || 0 } : { reports: 0, skiptrace: 0 },
        last_seen: seen[u.email]?.last || null, visits: seen[u.email]?.visits || 0, mrr: Math.round(mrr) };
    }).sort((a, b) => (b.last_seen || b.created || "").localeCompare(a.last_seen || a.created || ""));
    const totals = {
      users: rows.length, paying: rows.filter(r => r.sub && ["active", "trialing", "past_due"].includes(r.sub.status)).length,
      free: rows.filter(r => r.grant_active).length, blocked: rows.filter(r => r.blocked).length,
      mrr: rows.reduce((s, r) => s + r.mrr, 0), active_30d: rows.filter(r => r.last_seen && now - new Date(r.last_seen).getTime() < 30 * 864e5).length,
      reports_this_month: rows.reduce((s, r) => s + (r.usage?.reports || 0), 0),
    };
    return out(200, { users: rows, totals, month: m, stripe: stripeMode(), identity_error: error });
  }

  if (event.httpMethod !== "POST") return out(405, { error: "GET or POST" });
  let body: any = {}; try { body = JSON.parse(event.body || "{}"); } catch {}
  const email = norm(body.email);
  if (!email) return out(400, { error: "email required" });
  if (OWNER_EMAILS.has(email) && ["block", "delete", "reset-usage"].includes(body.action)) return out(400, { error: "That's the owner account." });
  const sub: any = await store.get(`sub:${email}`, { type: "json" }).catch(() => null);

  switch (body.action) {
    case "grant": {
      const plan = body.plan === "starter" ? "starter" : "pro";
      const reports = body.reports === "" || body.reports == null ? undefined : body.reports === "unlimited" ? null : Math.max(0, Math.min(10000, Math.round(Number(body.reports)) || 0));
      const months = Number(body.months || 0);
      await saveGrant({ email, plan, ...(reports !== undefined ? { reports } : {}), expires: months > 0 ? new Date(Date.now() + months * 30.44 * 864e5).toISOString() : null,
        note: String(body.note || "").slice(0, 120), by: me.email, at: new Date().toISOString() });
      break;
    }
    case "ungrant": await deleteGrant(email); break;
    case "block": await store.setJSON(`block:${email}`, { by: me.email, at: new Date().toISOString(), reason: String(body.reason || "").slice(0, 200) }); break;
    case "unblock": await store.delete(`block:${email}`); break;
    case "reset-usage": await store.delete(`usage:${email}:${month()}`); break;
    case "cancel-at-period-end": case "resume": case "cancel-now": {
      if (!sub?.subscription) return out(400, { error: "No Stripe subscription for this user." });
      if (body.action === "cancel-now") await stripe("DELETE", `/subscriptions/${sub.subscription}`);
      else await stripe("POST", `/subscriptions/${sub.subscription}`, { cancel_at_period_end: body.action === "cancel-at-period-end" ? "true" : "false" });
      // The Stripe webhook updates sub:<email>; mirror the change now so the page reflects it.
      await store.setJSON(`sub:${email}`, { ...sub, ...(body.action === "cancel-now" ? { status: "canceled" } : { cancel_at_period_end: body.action === "cancel-at-period-end" }), updated_at: new Date().toISOString() });
      break;
    }
    case "delete": {
      if (sub && ["active", "trialing", "past_due"].includes(sub.status)) return out(400, { error: "Cancel their subscription first." });
      const { users } = await identityUsers(identity);
      const u = users.find(x => norm(x.email) === email);
      if (u && identity?.url) {
        const r = await fetch(`${identity.url}/admin/users/${u.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${identity.token}` } });
        if (!r.ok && r.status !== 404) return out(502, { error: `Couldn't delete the sign-in (Identity ${r.status}).` });
      }
      await Promise.all([`grant:${email}`, `block:${email}`, `seen:${email}`, `member:${email}`].map(k => store.delete(k).catch(() => {})));
      break;
    }
    default: return out(400, { error: "Unknown action" });
  }
  const usage = await getUsage(email).catch(() => null);
  return out(200, { ok: true, action: body.action, email, usage });
};
