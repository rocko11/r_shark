// Tax & water/sewer arrears. NYC's live running balance of what a property owes
// isn't clean open data — it's in DOF's account lookup. What IS available is the
// Tax Lien Sale List (9rz4-mjek): properties with tax and/or water arrears large
// enough (and old enough) to be eligible for the annual lien sale. That's a strong
// threshold signal — being on it means serious delinquency that's on a path to a
// sellable lien and, ultimately, foreclosure.
//
// The list keys on borough+block+lot (no bbl). It carries a `cycle` (how far the
// notice process has gone: 10/30/60/90 Day Notice -> Final Sale) and a
// `water_debt_only` flag. It does NOT carry a dollar amount.

import * as sq from "./socrata.ts";

export async function checkArrears(bbl: string): Promise<{
  available: boolean;
  on_lien_sale_list: boolean;
  most_recent?: string | null;
  latest_cycle?: string | null;
  sold?: boolean;
  water_only?: boolean;
  appearances?: number;
  caveat: string;
  reason?: string;
}> {
  const clean = String(bbl).split(".")[0].padStart(10, "0");
  const boro = clean.slice(0, 1);
  const block = String(Number(clean.slice(1, 6))); // un-padded, matches dataset
  const lot = String(Number(clean.slice(6, 10)));

  let rows: any[];
  try {
    rows = await sq.query("tax_lien_sale", {
      where: `borough='${boro}' AND block='${block}' AND lot='${lot}'`,
      select: "month,cycle,water_debt_only",
      order: "month DESC",
      limit: 50,
    });
  } catch {
    return {
      available: false, on_lien_sale_list: false,
      reason: "Lien-sale-list lookup failed.",
      caveat: "Couldn't check the tax lien sale list. Verify arrears directly at the DOF property account page.",
    };
  }

  if (!rows.length) {
    return {
      available: true, on_lien_sale_list: false,
      caveat: "Not on the tax lien sale list — no tax or water arrears large enough to be lien-sale-eligible have been published for this lot. This is not a live balance: small or recent arrears, or charges below the lien-sale threshold, won't appear. Confirm the current balance at the DOF property account page before closing.",
    };
  }

  // Most recent appearance and how far the process got.
  const latest = rows[0];
  const norm = (v: any) => String(v ?? "").toUpperCase().startsWith("Y");
  // "Final Sale" anywhere in the history means a lien was actually sold.
  const sold = rows.some((r) => /final sale/i.test(String(r.cycle || "")));
  // Water-only if the most recent record says so.
  const waterOnly = norm(latest.water_debt_only);

  return {
    available: true,
    on_lien_sale_list: true,
    most_recent: latest.month ? String(latest.month).slice(0, 10) : null,
    latest_cycle: latest.cycle || null,
    sold,
    water_only: waterOnly,
    appearances: rows.length,
    caveat: sold
      ? "This lot's lien was sold at a tax lien sale — the debt (plus interest and fees) was transferred to a third-party buyer who can move toward foreclosure. This is a serious encumbrance; get a full title search and the current payoff before proceeding."
      : waterOnly
        ? "Appears on the lien sale list for WATER/SEWER charges. Water debt on a 1-family home can't itself be sold as a lien, but DEP can shut off service, and on other property types it can be sold. The list is a threshold signal, not a live balance — pull the DOF/DEP account for the exact amount owed."
        : "Appears on the tax lien sale list for tax and/or water arrears — meaning delinquency reached the lien-sale eligibility threshold. This is a point-in-time notice list, not a live balance. Get the current DOF payoff figure; unpaid, this path leads to a sold lien and possible foreclosure.",
  };
}
