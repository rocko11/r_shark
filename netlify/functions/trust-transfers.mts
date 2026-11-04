import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { KIND_LABEL, isSelfTransfer, trustKind } from "../lib/trusts.ts";

// GET /api/trust-transfers?months=3&boro=3&kind=irrevocable&self=1&paid=0&q=smith
// NYC properties deeded into family / living / irrevocable trusts (ACRIS), newest first.
// Data is pre-built by trust-build-background (daily, via trust-transfers-cron). If nothing is built yet, this kicks it off.
const json = (b: unknown, s = 200, cache = "public, max-age=900") =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });

export default async (req: Request, _ctx: Context) => {
  const u = new URL(req.url).searchParams;
  const store = getStore("trust-transfers");
  const idx: any = await store.get("index", { type: "json" }).catch(() => null);
  const keys = Object.keys(idx?.months || {}).sort().reverse();
  if (!keys.length) {
    const lastKick = idx?.kicked_at ? Date.parse(idx.kicked_at) : 0;
    if (Date.now() - lastKick > 20 * 60_000) {
      await store.setJSON("index", { months: {}, kicked_at: new Date().toISOString() });
      await fetch(new URL("/.netlify/functions/trust-build-background", req.url), { method: "POST" }).catch(() => {});
    }
    return json({ building: true, message: "Building the trust-transfer list from ACRIS for the first time — this takes a few minutes. Try again shortly." }, 202, "no-store");
  }
  const months = Math.max(1, Math.min(12, Number(u.get("months")) || 3));
  const boro = u.get("boro") || "";
  const kind = u.get("kind") || "";
  const self = u.get("self"), paid = u.get("paid");
  const text = (u.get("q") || "").trim().toUpperCase();
  const BOR = ["", "Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
  const rows: any[] = (await Promise.all(keys.slice(0, months).map(k => store.get(`month-${k}`, { type: "json" }).catch(() => [])))).flat()
    // re-derive classification at read time so older stored months pick up rule fixes
    .map((r: any) => ({ ...r, kind: trustKind(r.trust), self: isSelfTransfer(r.grantors, r.trust, r.amount) }));
  const out = rows.filter(r =>
    (!boro || r.lots.some((l: any) => l.bbl[0] === boro || l.borough === BOR[Number(boro)])) &&
    (!kind || r.kind === kind) &&
    (self !== "1" || r.amount <= 10) && (paid !== "1" || r.amount > 10) &&
    (!text || [...r.trust, ...r.grantors, ...r.lots.map((l: any) => l.address)].some((s: string) => String(s).toUpperCase().includes(text))));
  const counts: Record<string, number> = {};
  for (const r of out) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const covered = keys.slice(0, months).sort();
  return json({
    count: out.length, counts, kinds: KIND_LABEL,
    period: { from: `${covered[0]}-01`, to: idx.latest, months: covered },
    data_through: idx.latest, updated_at: idx.updated_at,
    rows: out.slice(0, 1500), truncated: out.length > 1500,
  });
};

export const config: Config = { path: "/api/trust-transfers" };
