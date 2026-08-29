// Single source of truth for every NYC Open Data (Socrata) dataset.
// Verified 2026-08-27 against the live portal. Re-run /api/canary on a schedule;
// IDs and field names drift, DOB especially.
//
// DOB SPLITS ITS DATA. Filings: BIS (legacy) + DOB NOW. Violations: THREE sets —
// 3h2n-5cm9 (older, BIS), 855j-jady (newer, DOB NOW), 6bgk-3dad (ECB/OATH).
// The two civil-penalty sets overlap per DOB's own docs, so dedupe.

export type KeyType = "bbl" | "bin" | "bbl_parts" | "doc_id" | "none";

export interface Dataset {
  slug: string;
  socrataId: string;
  key: KeyType;
  verified: boolean;
  canaryField: string;       // canary $selects this to detect schema drift
  bblField?: string;
  binField?: string;
  orderBy?: string;
  notes?: string;
}

export const BASE = "https://data.cityofnewyork.us/resource";

export const DATASETS: Record<string, Dataset> = {
  pluto: { slug: "pluto", socrataId: "64uk-42ks", key: "bbl", verified: true,
    canaryField: "bbl", bblField: "bbl",
    notes: "Version 26v1. Snapshot — lags subdivisions and new construction." },

  // ACRIS: no address field. Legals(borough/block/lot) -> document_id ->
  // Master(amounts) + Parties(names). Excludes Staten Island.
  acris_legals: { slug: "acris_legals", socrataId: "8h5j-fqxa", key: "bbl_parts",
    verified: true, canaryField: "document_id" },
  acris_master: { slug: "acris_master", socrataId: "bnx9-e6tj", key: "doc_id",
    verified: true, canaryField: "document_id", orderBy: "document_date DESC",
    notes: "Fields: document_id, doc_type, document_date, document_amt, recorded_datetime. NOT doc_date/doc_amount." },
  acris_parties: { slug: "acris_parties", socrataId: "636b-3b5g", key: "doc_id",
    verified: true, canaryField: "document_id",
    notes: "party_type 1 = grantor/seller, 2 = grantee/buyer" },
  acris_doc_codes: { slug: "acris_doc_codes", socrataId: "7isb-wh4c", key: "none",
    verified: false, canaryField: "doc_type" },

  // E-designations: CEQR environmental requirements (hazmat / air / noise) on a
  // tax lot. Keyed borough/block/lot like ACRIS legals. A real cost line.
  e_designations: { slug: "e_designations", socrataId: "jsrs-ggnx", key: "bbl_parts",
    verified: false, canaryField: "enumber",
    notes: "Fields: enumber, ceqr_number, borough, block, lot, e_designatio (type: Hazmat/Air/Noise)." },

  // DOB filings
  dob_now_jobs: { slug: "dob_now_jobs", socrataId: "w9ak-ipjd", key: "bin",
    verified: true, canaryField: "job_filing_number", binField: "bin", orderBy: "filing_date DESC" },
  dob_now_permits: { slug: "dob_now_permits", socrataId: "rbx6-tga4", key: "bin",
    verified: true, canaryField: "job_filing_number", binField: "bin", orderBy: "issued_date DESC" },
  dob_bis_jobs: { slug: "dob_bis_jobs", socrataId: "ic3t-wcy2", key: "bin",
    verified: true, canaryField: "job__", binField: "bin__", orderBy: "latest_action_date DESC",
    notes: "Legacy BIS. Fields carry trailing double underscores: job__, bin__." },
  dob_bis_permits: { slug: "dob_bis_permits", socrataId: "by8u-8ck5", key: "bin",
    verified: true, canaryField: "job__", binField: "bin__", orderBy: "issuance_date DESC" },

  // DOB violations (three datasets)
  dob_violations: { slug: "dob_violations", socrataId: "3h2n-5cm9", key: "bin",
    verified: true, canaryField: "isn_dob_bis_viol", binField: "bin", orderBy: "issue_date DESC",
    notes: "OLDER civil penalties from BIS." },
  dob_safety_violations: { slug: "dob_safety_violations", socrataId: "855j-jady", key: "bin",
    verified: true, canaryField: "bin", binField: "bin",
    notes: "NEWER civil penalties in DOB NOW. Overlaps 3h2n-5cm9 — dedupe." },
  ecb_violations: { slug: "ecb_violations", socrataId: "6bgk-3dad", key: "bin",
    verified: true, canaryField: "ecb_violation_number", binField: "bin", orderBy: "issue_date DESC",
    notes: "OATH/ECB summonses. penality_imposed is misspelled in source. Date is issue_date." },

  dob_complaints: { slug: "dob_complaints", socrataId: "eabe-havv", key: "bin",
    verified: true, canaryField: "complaint_number", binField: "bin", orderBy: "date_entered DESC" },
  certificates_of_occupancy: { slug: "certificates_of_occupancy", socrataId: "bs8b-p36w",
    key: "bin", verified: true, canaryField: "job_number", binField: "bin" },

  hpd_violations: { slug: "hpd_violations", socrataId: "wvxf-dwi5", key: "bbl",
    verified: true, canaryField: "violationid", bblField: "bbl", orderBy: "inspectiondate DESC",
    notes: "Housing Maintenance Code Violations. Class A/B/C/I." },
  hpd_registrations: { slug: "hpd_registrations", socrataId: "tesw-yqqr", key: "bbl",
    verified: false, canaryField: "registrationid", bblField: "bbl" },
  hpd_contacts: { slug: "hpd_contacts", socrataId: "feu5-w2e2", key: "registrationid",
    verified: false, canaryField: "registrationid", bblField: null,
    notes: "Registration Contacts. type=HeadOfficer/IndividualOwner/CorporateOwner/Agent, firstname, lastname, corporationname, business address. Join on registrationid." },
};

export const BOROUGH_NAME: Record<number, string> = {
  1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island",
};
export const ACRIS_BOROUGHS = new Set([1, 2, 3, 4]);

export function splitBBL(bbl: string): [number, number, number] {
  const b = String(bbl).trim();
  if (b.length !== 10 || !/^\d{10}$/.test(b)) throw new Error(`malformed BBL: ${bbl}`);
  return [Number(b[0]), Number(b.slice(1, 6)), Number(b.slice(6, 10))];
}
