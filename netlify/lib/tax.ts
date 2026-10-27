// NYC annual property tax.
//
//  1. fetchActualTax(bbl) — what DOF actually billed, from Property Charges Balance
//     (scjx-j6np). That dataset is a pile of monthly EXTRACTS: every bill appears once per
//     extract (4–8 copies), its `taxyear` column is the extract's year rather than the
//     fiscal year the bill belongs to, and bills get revised (e.g. when the Council adopts
//     new rates in the fall). So: keep code=CHG (property tax), and for each due date only
//     the rows from the newest extract; then group due dates into fiscal years
//     (Jul 1 – Jun 30). Summing everything — the old method — overstated taxes 3–4×.
//
//  2. estimatePropertyTax(pluto, bbl) — taxable billable AV × class rate. The taxable value
//     comes from DOF's Property Valuation & Assessment roll (8y4t-faws: curtxbtot minus the
//     exempt part), NOT PLUTO's assesstot: PLUTO carries the ACTUAL assessed value, but
//     DOF taxes the lower TRANSITIONAL / capped value (phase-ins for class 2 & 4, 6%/20%
//     caps for class 1) — PLUTO-based estimates ran ~10% high on commercial and far higher
//     on 1–3 family homes. PLUTO is only the fallback.
//
// Rates FY2026 (Jul 2025 – Jun 2026), still in effect for FY2027 bills until the Council
// adopts new ones. Verified 2026-10-26 by back-calculating from real FY2026 bills:
// class 1 19.843%, class 2 12.439%, class 4 10.848% (exact to 4 decimals).
// Update RATES / RATE_YEAR when new rates are adopted (usually Oct–Dec).

const DOF_CHARGES_URL = "https://data.cityofnewyork.us/resource/scjx-j6np.json";
const DOF_VALUATION_URL = "https://data.cityofnewyork.us/resource/8y4t-faws.json";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";

export const RATE_YEAR = "FY2026 rates (Jul 2025 – Jun 2026)";
export const RATES: Record<string, number> = {
  "1": 0.19843, // 1–3 family homes + small mixed-use
  "2": 0.12439, // condos, co-ops, 4+ unit residential
  "3": 0.11108, // utility
  "4": 0.10848, // commercial / industrial
};
const LABELS: Record<string, string> = {
  "1": "Class 1 · 1–3 family home / small mixed-use",
  "2": "Class 2 · condo, co-op, or 4+ unit residential",
  "3": "Class 3 · utility",
  "4": "Class 4 · commercial / industrial",
};

async function getJSON(url: string, ms = 7000): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const money = (n: number) => Math.round(n);
const fyOf = (iso: string) => { const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)); return m >= 7 ? y + 1 : y; };
const fyLabel = (fy: number) => `FY${fy} (Jul ${fy - 1} – Jun ${fy})`;

function taxClassFromBldg(pluto: any): string | null {
  // Fallback only. DOF building class first letter → tax class.
  const letter = String(pluto?.bldgclass ?? "").trim().toUpperCase().charAt(0);
  if (!letter) return null;
  if (["A", "B", "S"].includes(letter)) return "1";
  if (["C", "D", "R"].includes(letter)) return "2";
  if (letter === "U") return "3";
  return "4";
}

/* ---------------- 1. actual DOF bill ---------------- */
export interface ActualTax {
  annual: number;             // total property-tax charges for tax_year
  tax_year: string;
  fiscal_year: number;
  installments: number;       // 2 (semi-annual) or 4 (quarterly)
  installment: number;        // latest installment amount
  frequency: "quarterly" | "semi-annual";
  schedule: { due: string; amount: number }[];
  prior_year?: { fiscal_year: number; tax_year: string; annual: number };
  source: "dof_actual";
}

export async function fetchActualTax(bbl: string): Promise<ActualTax | null> {
  if (!bbl || !/^\d{10}$/.test(bbl)) return null;
  const since = `${new Date().getFullYear() - 3}-07-01`;
  const rows: any[] = await getJSON(`${DOF_CHARGES_URL}?${new URLSearchParams({
    parid: bbl, code: "CHG",
    $select: "due_date,cycle,sum_liab,extractdt",
    $where: `due_date >= '${since}'`,
    $limit: "1000",
  })}`, 8000).catch(() => []);
  if (!rows.length) return null;

  // Newest extract per due date, then sum that extract's charges for the date.
  const newest: Record<string, string> = {};
  for (const r of rows) {
    const d = String(r.due_date || "").slice(0, 10), x = String(r.extractdt || "");
    if (d && (!newest[d] || x > newest[d])) newest[d] = x;
  }
  const byDue: Record<string, number> = {};
  const cycleOf: Record<string, string> = {};
  for (const r of rows) {
    const d = String(r.due_date || "").slice(0, 10);
    if (!d || String(r.extractdt || "") !== newest[d]) continue;
    byDue[d] = (byDue[d] || 0) + (Number(r.sum_liab) || 0);
    if (r.cycle) cycleOf[d] = String(r.cycle);
  }
  const dues = Object.keys(byDue).filter(d => byDue[d] > 0).sort();
  if (!dues.length) return null;

  const byFY: Record<number, string[]> = {};
  for (const d of dues) (byFY[fyOf(d)] ||= []).push(d);
  // Billing frequency can change (e.g. a condo moving from quarterly to semi-annual),
  // so decide it per fiscal year from that year's own cycle codes (1Q..4Q vs 1S/3S, 1R/3R).
  const isQuarterly = (fy: number) => byFY[fy].some(d => /Q$/.test(cycleOf[d] || ""));
  const expected = (fy: number) => isQuarterly(fy) ? 4 : 2;
  const fys = Object.keys(byFY).map(Number).sort((a, b) => b - a);
  // Newest fiscal year with every installment billed; DOF bills ~a half-year ahead,
  // so a quarterly property is "complete" for the current FY only after the December bill.
  const full = fys.find(fy => byFY[fy].length >= expected(fy));
  if (!full) return null;
  const sumFY = (fy: number) => byFY[fy].reduce((s, d) => s + byDue[d], 0);
  const prev = fys.find(fy => fy < full && byFY[fy].length >= expected(fy));
  const sched = byFY[full].map(d => ({ due: d, amount: money(byDue[d]) }));
  return {
    annual: money(sumFY(full)),
    tax_year: fyLabel(full),
    fiscal_year: full,
    installments: byFY[full].length,
    installment: sched[sched.length - 1].amount,
    frequency: isQuarterly(full) ? "quarterly" : "semi-annual",
    schedule: sched,
    prior_year: prev ? { fiscal_year: prev, tax_year: fyLabel(prev), annual: money(sumFY(prev)) } : undefined,
    source: "dof_actual",
  };
}

/* ---------------- 2. estimate from DOF taxable assessed value ---------------- */
export async function fetchAssessment(bbl: string): Promise<null | {
  year: number; tax_class: string; market: number; actual: number; transitional: number; taxable: number; exempt: number; final: boolean;
}> {
  if (!bbl || !/^\d{10}$/.test(bbl)) return null;
  const rows: any[] = await getJSON(`${DOF_VALUATION_URL}?${new URLSearchParams({
    parid: bbl, $select: "year,period,curtaxclass,curmkttot,curacttot,curtrntot,curtxbtot,curtxbextot",
    $order: "year DESC, period DESC", $limit: "6",
  })}`).catch(() => []);
  const r = rows.find(x => Number(x.curtxbtot) > 0 || Number(x.curacttot) > 0);
  if (!r) return null;
  const taxableGross = Number(r.curtxbtot) || 0;
  const exempt = Number(r.curtxbextot) || 0;
  return {
    year: Number(r.year), tax_class: String(r.curtaxclass || "").trim(),
    market: Number(r.curmkttot) || 0, actual: Number(r.curacttot) || 0, transitional: Number(r.curtrntot) || 0,
    taxable: Math.max(0, taxableGross - exempt), exempt, final: String(r.period) === "3",
  };
}

export function estimatePropertyTax(pluto: any, assess?: Awaited<ReturnType<typeof fetchAssessment>>): {
  available: boolean;
  reason?: string;
  tax_class?: string;
  tax_class_code?: string;
  rate_year?: string;
  rate_pct?: number;
  market_value?: number;
  assessed_total?: number;
  exempt_total?: number;
  taxable_assessed?: number;
  annual_tax_estimate?: number;
  quarterly?: number;
  basis?: "dof_taxable" | "pluto_actual";
  roll_year?: string;
  effective_rate_note?: string;
  has_exemption?: boolean;
  caveat: string;
} {
  let cls: string | null, assessed: number, exempt: number, taxable: number, basis: "dof_taxable" | "pluto_actual";
  let market: number | undefined, rollYear: string | undefined;
  if (assess && assess.taxable + assess.exempt > 0) {
    cls = assess.tax_class.charAt(0) || taxClassFromBldg(pluto);
    assessed = assess.actual; exempt = assess.exempt; taxable = assess.taxable; basis = "dof_taxable";
    market = assess.market; rollYear = `${assess.year - 1}/${String(assess.year).slice(2)} ${assess.final ? "final" : "tentative"} roll`;
  } else {
    cls = String(pluto?.taxclass ?? "").trim().charAt(0) || taxClassFromBldg(pluto);
    assessed = Number(pluto?.assesstot) || 0; exempt = Number(pluto?.exempttot) || 0;
    taxable = Math.max(0, assessed - exempt); basis = "pluto_actual";
  }
  if (!cls || !RATES[cls] || (assessed <= 0 && taxable <= 0)) {
    return {
      available: false,
      reason: !cls ? "No tax class on record." : "No assessed value on record.",
      caveat: "Property tax can't be estimated without a tax class and assessed value. Check the DOF property page directly.",
    };
  }
  const rate = RATES[cls];
  const annual = taxable * rate;
  const hasExemption = exempt > 0;
  return {
    available: true,
    tax_class: LABELS[cls], tax_class_code: (assess?.tax_class || cls),
    rate_year: RATE_YEAR,
    rate_pct: rate * 100,
    market_value: market,
    assessed_total: money(assessed),
    exempt_total: money(exempt),
    taxable_assessed: money(taxable),
    annual_tax_estimate: money(annual),
    quarterly: money(annual / 4),
    basis, roll_year: rollYear,
    has_exemption: hasExemption,
    effective_rate_note: `${(rate * 100).toFixed(3)}% of the taxable assessed value (${RATE_YEAR}).`,
    caveat: basis === "dof_taxable"
      ? `Taxable billable assessed value from the DOF ${rollYear} × the class ${cls} rate${hasExemption ? ", after exemptions" : ""}. Abatements (421-a, J-51, co-op/condo, solar, ICAP) are credited on the bill and aren't in this estimate — the billed amount is authoritative.`
      : `DOF's assessment roll didn't respond, so this uses PLUTO's actual assessed value × the class rate. DOF taxes the lower transitional / capped value, so this runs HIGH — about 10% for commercial and much more for 1–3 family homes.`,
  };
}
