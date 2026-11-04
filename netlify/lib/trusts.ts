// Properties deeded into a (family / living / irrevocable) trust — from ACRIS.
//
// Why it matters: a deed into an irrevocable or "asset protection" trust usually means
// Medicaid / estate planning by an older owner; a revocable or living trust means the owner is
// planning their estate; and the trustee is often a child who will sell after the owner dies.
// All are strong off-market leads.
//
// How: ACRIS parties (636b-3b5g) is ~40M rows and a name LIKE '%TRUST%' over all of it times out,
// but document_id starts with the recording date (YYYYMMDD…), so a document_id range + party_type
// + LIKE runs in ~1–2 s per 10 days. Then: drop bank / mortgage-securitization trusts by name, keep
// only deeds (ACRIS master), attach the lot (legals) and the grantor (parties type 1).
// ACRIS on Open Data lags ~1 month; a month's list is built by a daily background job.

const B = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";

async function q(id: string, p: Record<string, string>, ms = 25000): Promise<any[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${B}/${id}.json?${new URLSearchParams(p)}`, { signal: AbortSignal.timeout(ms), headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
      if (r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 1500 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error(`${id} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return await r.json();
    } catch (e) { if (attempt === 2) throw e; await new Promise(z => setTimeout(z, 1500 * (attempt + 1))); }
  }
  return [];
}
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const inList = (c: string[]) => c.map(x => `'${x.replace(/'/g, "''")}'`).join(",");
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// Banks, trust companies and mortgage-securitization / investment trusts — not family trusts.
const INSTITUTIONAL = /\b(BANK|BANCORP|N\.?\s?A\.?$|NATIONAL ASSOCIATION|MORTGAGE|LOAN|REMIC|CERTIFICATE|SECURITI|ASSET[- ]BACKED|PARTICIPATION TRUST|TRUST COMPANY|TRUST CO\b|\bRPL\d|\bNPL\d|CAPITAL|FINANCIAL|FUNDING|LENDING|SAVINGS|CREDIT|INVESTMENT TRUST|REIT\b|HOLDINGS TRUST|ACQUISITION TRUST|TITLE TRUST|STATUTORY TRUST|OWNER TRUST|SERIES|LAND TRUST|HOUSING TRUST|COMMUNITY LAND|\b(19|20)\d\d-[A-Z0-9]+)/;
export function isFamilyTrustName(name: string) {
  const n = String(name || "").toUpperCase();
  return /\bTRUST|\bTTEE\b|TRUSTEE/.test(n) && !INSTITUTIONAL.test(n);
}
export type TrustKind = "irrevocable" | "revocable" | "trustee" | "other";
export function trustKind(names: string[]): TrustKind {
  const s = names.join(" | ").toUpperCase();
  if (/IRREVOCABLE|IRREV\b|ASSET PROTECTION|PROTECTIVE TRUST|MEDICAID|SUPPLEMENTAL NEEDS|SPECIAL NEEDS|QPRT|QUALIFIED PERSONAL RESIDENCE|ELDER/.test(s)) return "irrevocable";
  if (/REVOCABLE|LIVING TRUST|REV\.? LIV|\bREV TRUST|FAMILY TRUST/.test(s)) return "revocable";
  if (/TRUSTEE|\bTTEE\b/.test(s)) return "trustee";
  return "other";
}
export const KIND_LABEL: Record<TrustKind, string> = {
  irrevocable: "Irrevocable / Medicaid / asset-protection trust",
  revocable: "Revocable / living / family trust",
  trustee: "Trustee (trust type not stated)",
  other: "Trust",
};
// The grantor's surname appears in the trust / trustee names → the owner moved their own property into a trust.
export function isSelfTransfer(grantors: string[], trustees: string[]) {
  const tt = trustees.join(" ").toUpperCase();
  return grantors.some(g => {
    const sur = String(g || "").toUpperCase().split(",")[0].trim().split(/\s+/).pop() || "";
    return sur.length >= 3 && new RegExp(`\\b${sur.replace(/[^A-Z]/g, "")}\\b`).test(tt);
  });
}

const BORO = ["", "Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"];
export interface TrustDeed {
  doc: string; recorded: string; doc_date: string | null; doc_type: string; amount: number;
  trust: string[]; grantors: string[]; kind: TrustKind; self: boolean;
  lots: { bbl: string; borough: string; address: string; unit: string | null; property_type: string | null }[];
  trustee_address: string | null;
}

// All deeds into non-institutional trusts recorded between two dates (inclusive, YYYY-MM-DD).
export async function trustDeedsBetween(fromISO: string, toISO: string): Promise<TrustDeed[]> {
  // Split into ≤10-day document_id ranges — each is fast; one big range times out.
  const ranges: [string, string][] = [];
  for (let d = new Date(fromISO + "T00:00:00Z"); d <= new Date(toISO + "T00:00:00Z"); d = new Date(d.getTime() + 10 * 864e5)) {
    const end = new Date(Math.min(d.getTime() + 9 * 864e5, new Date(toISO + "T00:00:00Z").getTime()));
    const ymd = (x: Date) => x.toISOString().slice(0, 10).replace(/-/g, "");
    ranges.push([ymd(d) + "00000000", ymd(end) + "99999999"]);
  }
  const grantees = (await pool(ranges, 3, ([a, b]) => q("636b-3b5g", {
    $select: "document_id,name,address_1,city,state,zip",
    $where: `party_type='2' and document_id between '${a}' and '${b}' and upper(name) like '%TRUST%'`,
    $limit: "50000",
  }))).flat().filter(r => isFamilyTrustName(r.name));
  const ids = [...new Set(grantees.map(r => r.document_id))];
  if (!ids.length) return [];

  const masters = (await pool(chunk(ids, 150), 4, c => q("bnx9-e6tj", {
    $select: "document_id,doc_type,document_date,recorded_datetime,document_amt",
    $where: `document_id in(${inList(c)}) and doc_type in('DEED','DEEDO','DEED, LE','DEEDP')`, $limit: "5000",
  }))).flat();
  const dids = masters.map(m => m.document_id);
  const [legals, grantors] = await Promise.all([
    pool(chunk(dids, 150), 4, c => q("8h5j-fqxa", { $select: "document_id,borough,block,lot,street_number,street_name,unit,property_type", $where: `document_id in(${inList(c)})`, $limit: "5000" })).then(x => x.flat()),
    pool(chunk(dids, 150), 4, c => q("636b-3b5g", { $select: "document_id,name", $where: `document_id in(${inList(c)}) and party_type='1'`, $limit: "5000" })).then(x => x.flat()),
  ]);
  const by = (a: any[]) => a.reduce((m: Record<string, any[]>, r: any) => ((m[r.document_id] ||= []).push(r), m), {});
  const L = by(legals), G = by(grantors), T = by(grantees);
  const seen = new Set<string>();
  return masters.filter(m => !seen.has(m.document_id) && seen.add(m.document_id)).map((m: any) => {
    const trust = [...new Set((T[m.document_id] || []).map((x: any) => String(x.name).trim()))] as string[];
    const gr = [...new Set((G[m.document_id] || []).map((x: any) => String(x.name).trim()))] as string[];
    const t0 = (T[m.document_id] || [])[0] || {};
    return {
      doc: m.document_id, recorded: String(m.recorded_datetime || "").slice(0, 10), doc_date: m.document_date ? String(m.document_date).slice(0, 10) : null,
      doc_type: m.doc_type, amount: Number(m.document_amt) || 0, trust, grantors: gr, kind: trustKind(trust), self: isSelfTransfer(gr, trust),
      lots: (L[m.document_id] || []).map((l: any) => ({
        bbl: `${l.borough}${String(l.block).padStart(5, "0")}${String(l.lot).padStart(4, "0")}`, borough: BORO[Number(l.borough)] || String(l.borough),
        address: [l.street_number, l.street_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), unit: l.unit || null, property_type: l.property_type || null,
      })),
      trustee_address: [t0.address_1, t0.city, t0.state, t0.zip].filter(Boolean).join(", ") || null,
    };
  }).filter(r => r.lots.length).sort((a, b) => b.recorded.localeCompare(a.recorded) || b.doc.localeCompare(a.doc));
}

// For one property's report: is the current owner a trust, and has the lot ever been deeded into one?
export function trustStatus(title: any) {
  const own = title?.ownership;
  const hist: any[] = own?.history || [];
  const into = hist.filter(h => (h.to || []).some((n: string) => isFamilyTrustName(n)));
  const current = (own?.current_owner_all || []).some((n: string) => isFamilyTrustName(n));
  if (!into.length && !current) return { in_trust: false };
  const last = into[0] || hist[0];
  const names = (last?.to || own?.current_owner_all || []).filter((n: string) => isFamilyTrustName(n));
  const kind = trustKind(names);
  return {
    in_trust: current, kind, kind_label: KIND_LABEL[kind], trust_names: names,
    since: last?.date || null, from: last?.from || [], self: isSelfTransfer(last?.from || [], names),
    amount: last?.price ?? null, transfers: into.length,
  };
}
