import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { trustDeedsBetween } from "../lib/trusts.ts";

// Builds the "deeded into a trust" list, one blob per calendar month (trust-transfers/YYYY-MM).
// Runs daily (ACRIS on Open Data updates roughly monthly and back-fills late recordings), and can
// be kicked off on demand by /api/trust-transfers when the store is empty. Background function:
// up to 15 min, so the first full 12-month build (~20–30 s per month) fits.
const B = "https://data.cityofnewyork.us/resource";
const MONTHS = 12;

export default async () => {
  const store = getStore("trust-transfers");
  const r = await fetch(`${B}/bnx9-e6tj.json?$select=max(recorded_datetime)%20as%20d`).then(x => x.json()).catch(() => null);
  const latest = String(r?.[0]?.d || "").slice(0, 10) || new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
  const idx: any = (await store.get("index", { type: "json" }).catch(() => null)) || { months: {} };
  const end = new Date(latest + "T00:00:00Z");
  const done: string[] = [];
  for (let i = 0; i < MONTHS; i++) {
    const m = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    const key = m.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
    const to = (last > end ? end : last).toISOString().slice(0, 10);
    const prev = idx.months[key];
    // A month is final once it was built from data good through 60+ days after it ended.
    const final = prev && prev.complete && prev.through >= new Date(last.getTime() + 60 * 864e5).toISOString().slice(0, 10);
    if (final) continue;
    try {
      const rows = await trustDeedsBetween(`${key}-01`, to);
      await store.setJSON(`month-${key}`, rows);
      idx.months[key] = { count: rows.length, through: latest, built_at: new Date().toISOString(), complete: to === last.toISOString().slice(0, 10) };
      done.push(`${key}:${rows.length}`);
      await store.setJSON("index", { ...idx, latest, updated_at: new Date().toISOString() });
    } catch (e) { console.error("trust month failed", key, e); }
  }
  // keep only the window
  const keep = new Set(Array.from({ length: MONTHS }, (_, i) => new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)).toISOString().slice(0, 7)));
  for (const k of Object.keys(idx.months)) if (!keep.has(k)) { delete idx.months[k]; await store.delete(`month-${k}`).catch(() => {}); }
  await store.setJSON("index", { ...idx, latest, updated_at: new Date().toISOString(), building: false });
  console.log("trust-transfers built", done.join(" "));
};

export const config: Config = { schedule: "20 9 * * *" };
