// Title, ownership, liens, easements and foreclosure signals, derived from the
// ACRIS documents already gathered in report.ts. Everything here is "recorded
// documents found" — never "clear title." Only a title search is definitive.
//
// ACRIS doc_type values are short codes. The ones that matter for us:
//   DEED, DEEDO, RPTT&RET  -> ownership transfers
//   MTGE, AGMT, SPRD       -> mortgages / consolidations (liens)
//   SAT,  SATM, ASPM, RELM -> satisfaction / release of mortgage (discharges)
//   ML                     -> mechanic's lien
//   SML,  SATL             -> satisfaction of mechanic's lien
//   FTL                    -> federal tax lien   |  FTLR release
//   JL                     -> judgment lien       |  SJL / SATJ release
//   LP, CMTG, LIS PENDENS  -> lis pendens (foreclosure / title-litigation notice)
//   EASE, RPL, DECL        -> easement / reservation / declaration
//   UCC1, UCC3             -> UCC financing statements (fixture liens)
// Codes vary a little across ACRIS vintages, so we match on prefixes/keywords too.

type Doc = {
  document_id?: string; doc_type?: string; document_date?: string;
  recorded_datetime?: string; document_amount?: string | number;
  grantors?: string[]; grantees?: string[];
};

const up = (s: any) => String(s ?? "").toUpperCase().trim();
const money = (v: any) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const yr = (d?: string) => (d && d.length >= 4 ? d.slice(0, 4) : null);

// Doc-type classification -------------------------------------------------
const isDeed = (t: string) => /DEED|RPTT|CONF|GRANT|BARGAIN|EXECUTOR|ADMINISTRATOR|REFEREE|CONTRACT OF SALE/.test(t) && !/MASTER|MORT|LEASE|EASE|MODIF|ASSIGN/.test(t);
const isMortgage = (t: string) => /(^| )MTGE|MORTGAGE|^AGMT|CONSOL|SPRD|AL&R/.test(t);
const isMortgageSat = (t: string) => /SAT|RELEASE OF MORT|ASSIGNMENT OF MORT.*SAT|RELM|DISCHARGE/.test(t) && /MOR|MTG|SAT/.test(t);
const isMechanic = (t: string) => /MECHANIC|(^| )ML( |$)|LIEN.*MECH/.test(t);
const isMechanicSat = (t: string) => /(SATIS|DISCH|BOND|VACAT).*(MECH|LIEN)|(^| )SML( |$)|SATL/.test(t);
const isFedTax = (t: string) => /FEDERAL TAX|(^| )FTL( |$)/.test(t);
const isFedTaxRel = (t: string) => /FEDERAL TAX.*(RELEASE|DISCH)|FTLR/.test(t);
const isJudgment = (t: string) => /JUDG|(^| )JL( |$)/.test(t);
const isLisPendens = (t: string) => /LIS ?PENDEN|(^| )LP( |$)|NOTICE OF PENDEN/.test(t);
const isUcc = (t: string) => /UCC|FINANCING STATEMENT/.test(t) && !/TERMIN|RELEASE/.test(t);
const isUccTerm = (t: string) => /UCC.*(TERMIN|RELEASE)|TERMINATION/.test(t);
const isEasement = (t: string) => /EASEMENT|(^| )EASE( |$)|RIGHT.?OF.?WAY|DECLARATION|RESERVATION/.test(t);

// Given a lien doc and the full doc list, is there a later matching discharge?
// We can't match by document_id (satisfactions reference the original in the
// image, not in the open dataset), so we use the honest heuristic: a discharge
// of the same lien family recorded on/after the lien's date. This can over-clear
// in rare cases, so the label stays "no recorded discharge found," not "open."
function hasLaterDischarge(lien: Doc, docs: Doc[], matcher: (t: string) => boolean): boolean {
  const ld = lien.document_date || lien.recorded_datetime || "";
  return docs.some((d) => matcher(up(d.doc_type)) && (d.document_date || d.recorded_datetime || "") >= ld);
}

export type TitleAnalysis = ReturnType<typeof analyzeTitle>;

export function analyzeTitle(documents: Doc[], acrisAvailable: boolean) {
  if (!acrisAvailable) {
    return {
      available: false,
      reason: "ACRIS excludes Staten Island (Richmond County Clerk).",
      ownership: null, liens: [], open_lien_count: 0, easements: [],
      lis_pendens: [], e_designations: [],
    };
  }

  const docs = documents || [];
  const withType = docs.map((d) => ({ ...d, T: up(d.doc_type) }));

  // --- Ownership: chain from deeds, newest first ---
  const deeds = withType.filter((d) => isDeed(d.T))
    .sort((a, b) => (b.document_date || "").localeCompare(a.document_date || ""));
  const currentDeed = deeds[0];
  const ownership = {
    current_owner: currentDeed?.grantees?.[0] || null,
    current_owner_all: currentDeed?.grantees || [],
    acquired: currentDeed?.document_date || null,
    acquired_price: currentDeed ? money(currentDeed.document_amount) : null,
    seller_to_current: currentDeed?.grantors || [],
    history: deeds.slice(0, 12).map((d) => {
      const price = money(d.document_amount);
      // A deed with $0 or a nominal amount is usually an intra-family/LLC transfer,
      // not an arm's-length sale — flag it so it isn't read as a market comp.
      const nominal = price === null || price <= 10;
      return {
        date: d.document_date, year: yr(d.document_date),
        from: d.grantors || [], to: d.grantees || [],
        price, doc_type: d.doc_type,
        arms_length: !nominal,
        note: nominal ? "Nominal / $0 — likely a non-sale transfer (family, LLC restructure, or correction deed), not a market price." : null,
      };
    }),
    note: "Owner of record per most recent recorded deed. ACRIS shows the entity (often an LLC), not the individuals behind it.",
  };

  // --- Liens: mortgages, mechanic's, tax, judgment, UCC — with discharge match ---
  type Lien = {
    kind: string; doc_type?: string; date?: string; year: string | null;
    amount: number | null; creditor: string[]; debtor: string[];
    discharged: boolean; document_id?: string;
  };
  const liens: Lien[] = [];
  const pushLien = (d: any, kind: string, dischargeMatcher: (t: string) => boolean, creditorIsGrantee: boolean) => {
    liens.push({
      kind, doc_type: d.doc_type, date: d.document_date, year: yr(d.document_date),
      amount: money(d.document_amount),
      // For a mortgage, the lender (mortgagee) is party_type 2 => grantees here.
      // For most liens the claimant is the grantee side; debtor/owner the grantor.
      creditor: creditorIsGrantee ? (d.grantees || []) : (d.grantors || []),
      debtor: creditorIsGrantee ? (d.grantors || []) : (d.grantees || []),
      discharged: hasLaterDischarge(d, docs, dischargeMatcher),
      document_id: d.document_id,
    });
  };
  for (const d of withType) {
    if (isMortgage(d.T) && !isMortgageSat(d.T)) pushLien(d, "Mortgage", isMortgageSat, true);
    else if (isMechanic(d.T) && !isMechanicSat(d.T)) pushLien(d, "Mechanic's lien", isMechanicSat, true);
    else if (isFedTax(d.T) && !isFedTaxRel(d.T)) pushLien(d, "Federal tax lien", isFedTaxRel, true);
    else if (isJudgment(d.T)) pushLien(d, "Judgment lien", (t) => /SATIS|VACAT|RELEASE/.test(t) && /JUDG|JL/.test(t), true);
    else if (isUcc(d.T) && !isUccTerm(d.T)) pushLien(d, "UCC (fixture) filing", isUccTerm, true);
  }
  liens.sort((a, b) => Number(a.discharged) - Number(b.discharged) || (b.date || "").localeCompare(a.date || ""));
  const openLiens = liens.filter((l) => !l.discharged);

  // --- Easements (recorded only) ---
  const easements = withType.filter((d) => isEasement(d.T)).map((d) => ({
    doc_type: d.doc_type, date: d.document_date, year: yr(d.document_date),
    parties: [...(d.grantors || []), ...(d.grantees || [])].slice(0, 4),
  }));

  // --- Lis pendens (foreclosure / title-litigation notices) ---
  const lisPendens = withType.filter((d) => isLisPendens(d.T)).map((d) => ({
    doc_type: d.doc_type, date: d.document_date, year: yr(d.document_date),
    plaintiff: d.grantors || [], defendant: d.grantees || [],
    note: "A lis pendens is a notice that a lawsuit (often foreclosure) was filed. It does not state the outcome — check the NY courts SCROLL system for status.",
  })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return {
    available: true,
    ownership,
    liens,
    open_lien_count: openLiens.length,
    open_lien_amount: openLiens.reduce((s, l) => s + (l.amount || 0), 0),
    easements,
    lis_pendens: lisPendens,
    e_designations: [] as any[], // filled by report.ts from the e_designations dataset
  };
}
