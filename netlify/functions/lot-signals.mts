import type { Config, Context } from "@netlify/functions";

// GET /api/lot-signals?bbls=3011330064,3011330065,...&points=1
//
// Powers the map layers. For a list of BBLs (max 400) returns, per lot:
//   lien      – on the DOF tax/water lien sale list (+ cycle, water-only flag)
//   hpd_c     – count of open HPD Class C (immediately hazardous) violations
//   ecb_bal   – unpaid ECB balance in dollars (active violations only)
//   score     – simple 0-3 distress tier used for map colouring
// With points=1 it also returns [lat, lng] per BBL from PLUTO (used by the Hunt map,
// whose result rows don't all carry coordinates).
//
// Block/lot columns are formatted inconsistently across these datasets (padded vs
// unpadded), so we query with both forms of every block and normalise lots numerically.

const NYC = "https://data.cityofnewyork.us/resource";
const LIEN = `${NYC}/9rz4-mjek.json`;
const HPD = `${NYC}/wvxf-dwi5.json`;
const ECB = `${NYC}/6bgk-3dad.json`;
const PLUTO = `${NYC}/64uk-42ks.json`;
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";

const esc = (s: string) => s.replace(/'/g, "''");
const num = (v: unknown) => Number(String(v ?? "").replace(/\D/g, ""));

async function soda(base: string, params: Record<string, string>): Promise<any[]> {
  const p = new URLSearchParams(params);
  if (APP_TOKEN) p.set("$$app_token", APP_TOKEN);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${base}?${p.toString()}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export default async (req: Request, _ctx: Context) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" },
    });

  const u = new URL(req.url).searchParams;
  const bbls = [...new Set((u.get("bbls") || "").split(",").map((s) => s.replace(/\D/g, "")).filter((s) => s.length === 10))].slice(0, 400);
  if (!bbls.length) return json({ error: "bbls (comma-separated 10-digit BBLs) required" }, 400);
  const wantPoints = u.get("points") === "1";

  // Group requested lots by borough, then by block.
  const wanted = new Map<string, Set<number>>(); // "boro|blockNum" -> lot numbers
  for (const b of bbls) {
    const key = `${b[0]}|${Number(b.slice(1, 6))}`;
    if (!wanted.has(key)) wanted.set(key, new Set());
    wanted.get(key)!.add(Number(b.slice(6)));
  }
  const byBoro = new Map<string, number[]>();
  for (const key of wanted.keys()) {
    const [bo, bk] = key.split("|");
    if (!byBoro.has(bo)) byBoro.set(bo, []);
    byBoro.get(bo)!.push(Number(bk));
  }
  const blockList = (blocks: number[]) =>
    blocks.flatMap((b) => [`'${b}'`, `'${String(b).padStart(5, "0")}'`]).join(",");

  const signals: Record<string, { lien?: string; hpd_c?: number; ecb_bal?: number; score: number }> = {};
  const touch = (bbl: string) => (signals[bbl] ||= { score: 0 });
  const mk = (bo: string, blk: unknown, lot: unknown) =>
    `${bo}${String(num(blk)).padStart(5, "0")}${String(num(lot)).padStart(4, "0")}`;
  const isWanted = (bo: string, blk: unknown, lot: unknown) =>
    wanted.get(`${bo}|${num(blk)}`)?.has(num(lot)) === true;
  const errors: string[] = [];

  const jobs: Promise<void>[] = [];
  for (const [bo, blocks] of byBoro) {
    const bl = blockList(blocks);

    jobs.push((async () => {
      try {
        const rows = await soda(LIEN, {
          $select: "borough,block,lot,cycle,water_debt_only",
          $where: `borough='${esc(bo)}' AND block in(${bl})`,
          $limit: "5000",
        });
        for (const r of rows) {
          if (!isWanted(bo, r.block, r.lot)) continue;
          const s = touch(mk(bo, r.block, r.lot));
          s.lien = String(r.water_debt_only || "").toUpperCase() === "YES" ? "Water/sewer lien" : "Tax lien";
          if (r.cycle) s.lien += ` · ${r.cycle}`;
        }
      } catch (e) { errors.push(`lien: ${(e as Error).message}`); }
    })());

    jobs.push((async () => {
      try {
        const rows = await soda(HPD, {
          $select: "block,lot",
          $where: `boroid=${Number(bo)} AND class='C' AND currentstatusid=2 AND block in(${bl})`,
          $limit: "20000",
        });
        for (const r of rows) {
          if (!isWanted(bo, r.block, r.lot)) continue;
          const s = touch(mk(bo, r.block, r.lot));
          s.hpd_c = (s.hpd_c || 0) + 1;
        }
      } catch (e) { errors.push(`hpd: ${(e as Error).message}`); }
    })());

    jobs.push((async () => {
      try {
        const rows = await soda(ECB, {
          $select: "block,lot,balance_due",
          $where: `boro='${esc(bo)}' AND ecb_violation_status='ACTIVE' AND balance_due>0 AND block in(${bl})`,
          $limit: "20000",
        });
        for (const r of rows) {
          if (!isWanted(bo, r.block, r.lot)) continue;
          const s = touch(mk(bo, r.block, r.lot));
          s.ecb_bal = (s.ecb_bal || 0) + Math.round(Number(r.balance_due) || 0);
        }
      } catch (e) { errors.push(`ecb: ${(e as Error).message}`); }
    })());
  }

  const points: Record<string, [number, number]> = {};
  if (wantPoints) {
    for (let i = 0; i < bbls.length; i += 100) {
      const chunk = bbls.slice(i, i + 100);
      jobs.push((async () => {
        try {
          const rows = await soda(PLUTO, {
            $select: "bbl,latitude,longitude",
            $where: `bbl in(${chunk.join(",")})`,
            $limit: "500",
          });
          for (const r of rows) {
            const id = String(r.bbl || "").split(".")[0].padStart(10, "0");
            const la = Number(r.latitude), lo = Number(r.longitude);
            if (Number.isFinite(la) && Number.isFinite(lo) && la && lo) points[id] = [la, lo];
          }
        } catch (e) { errors.push(`pluto: ${(e as Error).message}`); }
      })());
    }
  }

  await Promise.all(jobs);

  // Tier: 0 none · 1 minor (a few violations / small fines) · 2 serious · 3 lien-sale listed
  // or multiple signals stacked. Mirrors the deal-signal hierarchy: liens matter most.
  for (const s of Object.values(signals)) {
    const hits = (s.lien ? 1 : 0) + (s.hpd_c ? 1 : 0) + (s.ecb_bal ? 1 : 0);
    if (s.lien || hits >= 2) s.score = 3;
    else if ((s.hpd_c || 0) >= 3 || (s.ecb_bal || 0) >= 5000) s.score = 2;
    else if (hits >= 1) s.score = 1;
  }

  return json({ count: Object.keys(signals).length, signals, points: wantPoints ? points : undefined, errors: errors.length ? errors : undefined });
};

export const config: Config = { path: "/api/lot-signals" };
