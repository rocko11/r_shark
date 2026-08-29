// Annual property tax estimate. NYC's actual tax BILL is not a single open-data
// field — it's computed by DOF from the taxable assessed value and the tax-class
// rate, then reduced by abatements/exemptions (421-a, J-51, co-op/condo abatement,
// STAR, SCHE, veterans). We compute the unabated baseline precisely from PLUTO's
// assessed values and the published class rates, and flag that the real bill is
// lower where an exemption applies.
//
// Rates: FY2026 FINAL, adopted by City Council Oct 29 2025, retroactive to
// Jul 1 2025 (tax year Jul 2025 – Jun 2026). Verified against nyc.gov/finance.
// These change yearly — update RATES and RATE_YEAR each July.

const RATE_YEAR = "FY2026 (Jul 2025 – Jun 2026)";
const RATES: Record<string, number> = {
  "1": 0.19843, // 1–3 family homes + small mixed-use
  "2": 0.12439, // condos, co-ops, 4+ unit residential
  "3": 0.11108, // utility
  "4": 0.10848, // commercial / industrial
};

function taxClassOf(pluto: any): { code: string; label: string } | null {
  // PLUTO taxclass can be "1", "1A", "2", "2A", "2B", "4", etc. First digit is the class.
  const raw = String(pluto?.taxclass ?? pluto?.taxclass2 ?? "").trim();
  const d = raw.charAt(0);
  if (!["1", "2", "3", "4"].includes(d)) return null;
  const labels: Record<string, string> = {
    "1": "Class 1 · 1–3 family home / small mixed-use",
    "2": "Class 2 · condo, co-op, or 4+ unit residential",
    "3": "Class 3 · utility",
    "4": "Class 4 · commercial / industrial",
  };
  return { code: d, label: labels[d] };
}

const money = (n: number) => Math.round(n);

export function estimatePropertyTax(pluto: any): {
  available: boolean;
  reason?: string;
  tax_class?: string;
  rate_year?: string;
  rate_pct?: number;
  assessed_total?: number;
  exempt_total?: number;
  taxable_assessed?: number;
  annual_tax_estimate?: number;
  quarterly?: number;
  effective_rate_note?: string;
  has_exemption?: boolean;
  caveat: string;
} {
  const cls = taxClassOf(pluto);
  const assessTot = Number(pluto?.assesstot) || 0;
  const exemptTot = Number(pluto?.exempttot) || 0;

  if (!cls || assessTot <= 0) {
    return {
      available: false,
      reason: !cls ? "No tax class on the PLUTO record." : "No assessed value on the PLUTO record.",
      caveat: "Property tax can't be estimated without a tax class and assessed value. Check the DOF property page directly.",
    };
  }

  const rate = RATES[cls.code];
  const taxable = Math.max(0, assessTot - exemptTot);
  const annual = taxable * rate;
  const hasExemption = exemptTot > 0;

  // Class 2/3/4 over $250k assessed bill semi-annually; others quarterly. Show quarterly
  // as the common case; note the semi-annual threshold.
  const quarterly = annual / 4;

  return {
    available: true,
    tax_class: cls.label,
    rate_year: RATE_YEAR,
    rate_pct: rate * 100,
    assessed_total: money(assessTot),
    exempt_total: money(exemptTot),
    taxable_assessed: money(taxable),
    annual_tax_estimate: money(annual),
    quarterly: money(quarterly),
    has_exemption: hasExemption,
    effective_rate_note: `${(rate * 100).toFixed(3)}% of the taxable assessed value (${RATE_YEAR}).`,
    caveat: hasExemption
      ? `This uses PLUTO's assessed and exempt values, so it already nets out the exempt portion on record — but abatements (421-a, J-51, co-op/condo, STAR) that reduce the bill further may not be fully reflected. Treat as an estimate; the DOF bill is authoritative.`
      : `Unabated estimate from assessed value × class rate. If the property has any abatement or exemption (421-a, J-51, co-op/condo abatement, STAR, SCHE, veterans), the actual DOF bill will be lower. Assessed values also update each January; this reflects the value on the current PLUTO record.`,
  };
}
