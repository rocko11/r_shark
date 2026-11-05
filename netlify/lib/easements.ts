// Recorded easements and other recorded encumbrances on a lot, in detail.
//
// ACRIS gives us, per document: type, dates, CRFN, amount, every party with mailing address,
// every lot the document covers (with ACRIS's own easement / air-rights / subterranean / partial-lot
// flags), free-text remarks, and cross-references to later documents (amendments, terminations).
// From that we work out who benefits, which neighbouring lots are involved, what kind of
// easement it probably is, whether it looks terminated, and what it means for underwriting.
import * as sq from "./socrata.ts";

const BASE = "https://data.cityofnewyork.us/resource";
const REMARKS = `${BASE}/9p4w-7npp.json`;     // ACRIS Real Property Remarks
const REFS = `${BASE}/pwkr-dpni.json`;        // ACRIS Real Property References
const chunk = <T,>(xs: T[], n = 120) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const up = (s: any) => String(s ?? "").toUpperCase().trim();

// Recorded encumbrances worth a buyer's attention (ACRIS doc_type codes / descriptions).
const KIND_BY_CODE: Record<string, string> = {
  "EASE": "Easement", "DECL": "Declaration", "DEED, RC": "Deed with restrictive covenant",
  "AIRRIGHT": "Air rights", "DEVR": "Development rights", "LIC": "License", "ZLDA": "Zoning lot description agreement",
  "RPL": "Reservation",
};
const isEncumbrance = (t: string) => t in KIND_BY_CODE || /EASE|LIGHT.*AIR|AIR ?RIGHT|DEVELOPMENT RIGHT|RESTRICT|RIGHT.?OF.?WAY|PARTY WALL|ACCESS|RESERVATION/.test(t);
const isNoise = (t: string) => /CONDO|DECLARATION OF MODIFI|DEMM|MERGER/.test(t);
const isTermination = (t: string) => /^TER|TERMINAT|RELEASE OF EASE|RELEASE/.test(t);

type Kind = { key: string; label: string; note: string };
const KINDS: { key: string; label: string; test: (s: string) => boolean; note: string }[] = [
  { key: "utility", label: "Utility easement", test: s => /CON(SOLIDATED)? ?ED|EDISON|NATIONAL GRID|KEYSPAN|BROOKLYN UNION GAS|VERIZON|EMPIRE CITY SUBWAY|NEW YORK TELEPHONE|SPECTRUM|TIME WARNER|ALTICE|CABLEVISION|TRANSFORMER|VAULT|ELECTRIC|GAS MAIN/.test(s),
    note: "A utility can keep equipment (vaults, lines, transformers) on or under part of the lot and enter to maintain it. Usually you can't build over the easement area without the utility's consent, so check where it sits before you plan foundations or a cellar." },
  { key: "public", label: "City / public easement", test: s => /CITY OF NEW YORK|DEPT\.? OF ENVIRONMENTAL|DEP\b|DEPARTMENT OF TRANSPORTATION|\bDOT\b|MTA|TRANSIT AUTHORITY|SCHOOL CONSTRUCTION|PEOPLE OF THE STATE|HOUSING AUTHORITY|\bNYCHA\b/.test(s),
    note: "A public agency holds rights here (sewer, transit, street widening, public access). These are hard to remove. Confirm the area and any building limits with the agency." },
  { key: "light_air", label: "Light and air easement", test: s => /LIGHT.{0,6}AIR/.test(s),
    note: "Limits how high or how close you can build on part of the lot so a neighbour keeps light and air. This can directly cut buildable floor area, so map the restricted area against your massing." },
  { key: "air_rights", label: "Air / development rights", test: s => /AIR ?RIGHT|DEVELOPMENT RIGHT|ZONING LOT|ZLDA|DEVR/.test(s),
    note: "Floor area may have been transferred to or from this lot, or the lot merged into a larger zoning lot. That changes how much you can actually build. Read the agreement before you rely on the zoning numbers." },
  { key: "access", label: "Access / right-of-way", test: s => /ACCESS|INGRESS|EGRESS|RIGHT.?OF.?WAY|DRIVEWAY|PASSAGE|ALLEY/.test(s),
    note: "Someone else may cross part of the lot (or this lot crosses a neighbour). The path has to stay open, which can constrain the site plan, parking and construction staging." },
  { key: "party_wall", label: "Party wall / support", test: s => /PARTY WALL|SUPPORT|UNDERPIN|ENCROACH/.test(s),
    note: "Covers a shared wall or structural support between buildings. Expect obligations to protect the neighbour during demolition or excavation." },
  { key: "construction", label: "Construction / license agreement", test: s => /CRANE|SCAFFOLD|TIE.?BACK|PROTECT|LICENSE|TEMPORARY|OVERHEAD|SIDEWALK SHED|NETTING|MONITOR/.test(s),
    note: "Often a temporary right for a neighbour's construction (crane swing, tie-backs, protection). It may have expired. Check the end date and whether anything was left in the ground (tie-backs, anchors)." },
  { key: "restrictive", label: "Restrictive covenant / declaration", test: s => /RESTRICT|COVENANT|DECLARATION|DECL\b/.test(s),
    note: "Recorded restrictions on use or development, or obligations that run with the land (for example from a zoning approval). These bind every future owner, so read them before you underwrite a new use." },
];
function classify(doc: { doc_type: string; parties: { name: string }[]; remarks: string[] }): Kind {
  const hay = up([doc.doc_type, ...doc.parties.map(p => p.name), ...doc.remarks].join(" | "));
  const k = KINDS.find(k => k.test(hay));
  if (k) return k;
  return { key: "private", label: "Private easement", note: "A recorded right between private owners. The document itself says what area it covers, who may use it, and whether it ends. Have your title company map it." };
}

async function getJSON(url: string, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const soql = (base: string, params: Record<string, string>) => `${base}?${new URLSearchParams(params).toString()}`;

export async function buildEasements(bbl: string) {
  const b = bbl.replace(/\D/g, "");
  const borough = Number(b[0]), block = Number(b.slice(1, 6)), lot = Number(b.slice(6));
  if (borough === 5) return { available: false, reason: "Staten Island records are kept by the Richmond County Clerk, not ACRIS.", easements: [] };

  const legals = await sq.query("acris_legals", { where: sq.buildWhere({ borough, block, lot }), limit: 1000, retries: 1 });
  const myLegal: Record<string, any> = {};
  for (const l of legals) myLegal[l.document_id] = l;
  const ids = [...new Set(legals.map((l: any) => l.document_id).filter(Boolean))] as string[];
  if (!ids.length) return { available: true, easements: [], terminations: [], count: 0 };

  const masters = (await Promise.all(chunk(ids).map(c => sq.query("acris_master", {
    where: sq.buildIn("document_id", c), select: "document_id,doc_type,document_date,recorded_datetime,document_amt,crfn,percent_trans", limit: 1000, retries: 1 })))).flat();

  const enc = masters.filter((m: any) => {
    const t = up(m.doc_type);
    // Any document whose legal on this lot carries ACRIS's easement flag also counts (e.g. a deed granting an easement).
    return (isEncumbrance(t) && !isNoise(t)) || up(myLegal[m.document_id]?.easement) === "Y";
  });
  const terms = masters.filter((m: any) => isTermination(up(m.doc_type)) && !/MORT|MTG|UCC|LIEN|TAX|LEASE|L&R|TRUST|CONDO/.test(up(m.doc_type)));
  if (!enc.length) return { available: true, easements: [], terminations: terms.length, count: 0 };

  const encIds = enc.map((m: any) => m.document_id);
  const termIds = terms.map((m: any) => m.document_id);
  const failed: Record<string, string> = {};
  const safe = async <T,>(name: string, p: Promise<T>, fb: T): Promise<T> => { try { return await p; } catch (e: any) { failed[name] = String(e?.message || e); return fb; } };

  const [parties, allLegals, remarks, refsTo, refsFrom] = await Promise.all([
    safe("parties", Promise.all(chunk(encIds).map(c => sq.query("acris_parties", { where: sq.buildIn("document_id", c), limit: 2000, retries: 1 }))).then(x => x.flat()), [] as any[]),
    safe("legals", Promise.all(chunk(encIds).map(c => sq.query("acris_legals", { where: sq.buildIn("document_id", c), limit: 2000, retries: 1 }))).then(x => x.flat()), [] as any[]),
    safe("remarks", getJSON(soql(REMARKS, { $where: `document_id in(${encIds.map(q).join(",")})`, $limit: "500" })), [] as any[]),
    // Later documents (on this lot) that point back at an easement — amendments, assignments, terminations.
    termIds.length ? safe("references", getJSON(soql(REFS, { $where: `document_id in(${termIds.map(q).join(",")})`, $limit: "500" }), 12000), [] as any[]) : Promise.resolve([] as any[]),
    safe("references", getJSON(soql(REFS, { $where: `document_id in(${encIds.map(q).join(",")})`, $limit: "500" }), 12000), [] as any[]),
  ]);

  const by = <T extends { document_id?: string }>(rows: T[]) => { const m: Record<string, T[]> = {}; for (const r of rows) (m[r.document_id || ""] ||= []).push(r); return m; };
  const P = by(parties), L = by(allLegals), R = by(remarks), RF = by(refsFrom);
  const termMaster: Record<string, any> = {}; for (const t of terms) termMaster[t.document_id] = t;
  // termination doc → the easement it references (by doc id or CRFN)
  const encByCrfn: Record<string, string> = {}; for (const m of enc) if (m.crfn) encByCrfn[m.crfn] = m.document_id;
  const terminatedBy: Record<string, any> = {};
  for (const r of refsTo as any[]) {
    const target = r.reference_by_doc_id || encByCrfn[r.reference_by_crfn_ || r.reference_by_crfn || ""];
    if (target && encIds.includes(target)) terminatedBy[target] = termMaster[r.document_id];
  }

  const day = (s: any) => s ? String(s).slice(0, 10) : null;
  const self = `${borough}-${block}-${lot}`;
  const items = enc.map((m: any) => {
    const ps = (P[m.document_id] || []).map((p: any) => ({
      role: String(p.party_type) === "1" ? "grantor" : String(p.party_type) === "2" ? "grantee" : "party",
      name: p.name, address: [p.address_1, p.address_2, [p.city, p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
    }));
    const lots = (L[m.document_id] || []).map((l: any) => ({
      bbl: `${l.borough}${String(l.block).padStart(5, "0")}${String(l.lot).padStart(4, "0")}`,
      this_lot: `${l.borough}-${Number(l.block)}-${Number(l.lot)}` === self,
      address: [l.street_number, l.street_name].filter(Boolean).join(" ") || null,
      easement_flag: up(l.easement) === "Y", air_rights: up(l.air_rights) === "Y", subterranean: up(l.subterranean_rights) === "Y",
      partial: up(l.partial_lot) === "P",
    }));
    const mine = lots.find(l => l.this_lot) || (myLegal[m.document_id] ? {
      easement_flag: up(myLegal[m.document_id].easement) === "Y", air_rights: up(myLegal[m.document_id].air_rights) === "Y",
      subterranean: up(myLegal[m.document_id].subterranean_rights) === "Y", partial: up(myLegal[m.document_id].partial_lot) === "P" } as any : null);
    const others = lots.filter(l => !l.this_lot);
    const rem = (R[m.document_id] || []).sort((a: any, b: any) => Number(a.sequence_number) - Number(b.sequence_number)).map((r: any) => r.remark_text).filter(Boolean);
    const kind = classify({ doc_type: KIND_BY_CODE[up(m.doc_type)] || m.doc_type, parties: ps, remarks: rem });
    const term = terminatedBy[m.document_id];
    const refs = (RF[m.document_id] || []).map((r: any) => r.reference_by_crfn_ || r.reference_by_doc_id).filter(Boolean);
    const scope = [mine?.partial ? "covers part of this lot" : mine ? "covers the whole lot" : null, mine?.air_rights && "air rights", mine?.subterranean && "below ground"].filter(Boolean).join(" · ");
    if (kind.key === "private" && !/EASE/.test(up(m.doc_type)) && !mine?.easement_flag) { kind.label = KIND_BY_CODE[up(m.doc_type)] || "Recorded encumbrance"; }
    return {
      document_id: m.document_id, crfn: m.crfn || null, doc_type: m.doc_type, doc_label: KIND_BY_CODE[up(m.doc_type)] || m.doc_type,
      document_date: day(m.document_date), recorded: day(m.recorded_datetime), amount: m.document_amt ? Number(m.document_amt) : null,
      kind: kind.key, kind_label: kind.label, underwriting: kind.note,
      scope: scope || null, other_lots: others.slice(0, 12), other_lot_count: others.length,
      parties: ps, remarks: rem.slice(0, 6), references: refs.slice(0, 6),
      status: term ? "possibly terminated" : "of record",
      terminated_by: term ? { document_id: term.document_id, doc_type: term.doc_type, date: day(term.document_date) } : null,
    };
  }).sort((a: any, b: any) => (b.document_date || "").localeCompare(a.document_date || ""));

  const neighbors = new Set(items.flatMap((e: any) => e.other_lots.map((l: any) => l.bbl)));
  const kinds = [...new Set(items.map((e: any) => e.kind_label))];
  const active = items.filter((e: any) => e.status === "of record").length;
  return {
    available: true, count: items.length, active, kinds, neighbor_lots: neighbors.size,
    headline: `${items.length} recorded easement${items.length > 1 ? "s" : ""} or encumbrance${items.length > 1 ? "s" : ""} (${kinds.join(", ")})${neighbors.size ? `, involving ${neighbors.size} other lot${neighbors.size > 1 ? "s" : ""}` : ""}.${items.length - active ? ` ${items.length - active} may have been terminated.` : ""}`,
    easements: items, sources_failed: failed,
  };
}
