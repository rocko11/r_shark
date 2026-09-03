import type { Config } from "@netlify/functions";

// ── R Shark: Daily Motivated Seller Report — per ZIP ────────────────────────
// Runs 7 AM ET daily. One email per ZIP. Scores every distressed property on
// the full set of publicly-available motivated-seller signals.
//
// SCORING MODEL — Motivated Seller Index (0–100):
//
//   FINANCIAL DISTRESS (from DOF Lien Sale List):
//     Lien at Final Sale / sold at auction      +40  ← owner lost control
//     Active tax or water lien                  +20
//     Water lien bonus (no water = likely vacant) +10
//     Chronic: on lien list 3+ years            +15
//     Chronic: on lien list 2 years             +8
//
//   LEGAL PRESSURE (from ACRIS):
//     Lis pendens filed (foreclosure action)    +35  ← court already involved
//
//   CODE VIOLATIONS (from HPD + DOB + ECB):
//     HPD Class C (immediately hazardous)       +5 each, max +20
//     ECB unpaid DOB fines                      +1 per $1k, max +15
//     DOB civil violations (open)               +3 each, max +12
//
//   STALLED CONSTRUCTION (from DOB BIS + DOB NOW):
//     Stop Work Order active                    +30  ← DOB shut it down
//     Stalled/on-hold/expired permit            +20  ← developer stuck
//
//   PROPERTY SIGNALS (from PLUTO):
//     Vacant lot (no building)                  +15  ← pure carrying cost
//     Large lot ≥5,000 sf                       +5   ← more upside for buyer
//     Low assessed value vs lot size            +5   ← likely older owner
//
//   ESTATE / PROBATE / TRUST (from PLUTO ownername):
//     Executor or administrator of estate       +20  ← probate in progress, heirs want cash
//     "ESTATE OF [NAME]" (owner deceased)       +15  ← heirs lack attachment, want to liquidate
//     Irrevocable trust                         +8   ← often indicates owner incapacitated/deceased
//     Held in trust (AS TRUSTEE)               +3   ← weaker signal
//
// MARKET COMPARISON SECTION:
//   Each email also shows recent deed sales in the same ZIP (from ACRIS)
//   so you can compare distressed leads against what's actually closing.
//
// Env vars required (Netlify → Project configuration → Environment variables):
//   RESEND_API_KEY      from resend.com (free tier)
//   REPORT_EMAIL_TO     e.g. roeipaz@gmail.com
//   REPORT_EMAIL_FROM   e.g. reports@rshark.net (verified in Resend)
//   REPORT_ZIPS         comma-separated: 11238,10036,11201
//   SOCRATA_APP_TOKEN   already set

const PLUTO  = "https://data.cityofnewyork.us/resource/64uk-42ks.json";
const LIEN   = "https://data.cityofnewyork.us/resource/9rz4-mjek.json";
const HPD    = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";
const ECB    = "https://data.cityofnewyork.us/resource/6bgk-3dad.json";
const ACRIS_LEGAL  = "https://data.cityofnewyork.us/resource/8h5j-fqxa.json";
const ACRIS_MASTER = "https://data.cityofnewyork.us/resource/bnx9-e6tj.json";
// DOB: stalled construction + stop work orders + civil violations
const DOB_JOBS = "https://data.cityofnewyork.us/resource/ic3t-wcy2.json";  // BIS job applications
const DOB_NOW  = "https://data.cityofnewyork.us/resource/ipu4-2q9a.json";  // DOB NOW permits
const DOB_VIOL = "https://data.cityofnewyork.us/resource/3h2n-5cm9.json";  // DOB civil violations
const RESEND = "https://api.resend.com/emails";

const TOKEN = process.env.SOCRATA_APP_TOKEN;
const ZIPS  = (process.env.REPORT_ZIPS || "11238").split(",").map(z => z.trim()).filter(Boolean);

// Borough digit → name
const BORO_NAME: Record<string,string> = {"1":"Manhattan","2":"Bronx","3":"Brooklyn","4":"Queens","5":"Staten Island"};
// Borough name → digit (for HPD)
const BORO_D: Record<string,string> = {MANHATTAN:"1",BRONX:"2",BROOKLYN:"3",QUEENS:"4","STATEN ISLAND":"5"};
// ZIP → borough digit lookup (common NYC ZIPs)
const ZIP_BORO: Record<string,string> = {};
// We derive borough from lien data; fallback by range

// ── ZIP → StreetEasy area slug mapping ─────────────────────────────────────
const ZIP_SE_AREA: Record<string,string> = {
  "11238":"prospect-heights", "11201":"brooklyn-heights",
  "11222":"greenpoint",       "11237":"bushwick",
  "11206":"east-williamsburg","11211":"williamsburg",
  "11215":"park-slope",       "11217":"boerum-hill",
  "11231":"carroll-gardens",  "11205":"clinton-hill",
  "11221":"bed-stuy",         "11233":"crown-heights",
  "10036":"hells-kitchen",    "10011":"chelsea",
  "10014":"west-village",     "10013":"tribeca",
  "10002":"lower-east-side",  "10003":"east-village",
  "10025":"upper-west-side",  "10128":"upper-east-side",
  "11101":"long-island-city", "11103":"astoria",
};

type Listing = {
  address: string; price: number; beds: number|null; baths: number|null;
  sqft: number|null; days_on_market: number|null; url: string; building_type: string;
};

// Fetch active for-sale listings from StreetEasy's internal GraphQL API.
// No API key required. Falls back silently if the endpoint is unavailable.
async function fetchListings(zip: string): Promise<{listings:Listing[], median_price:number|null, total:number}> {
  const area = ZIP_SE_AREA[zip];
  if (!area) return { listings: [], median_price: null, total: 0 };

  // Enum values must be inlined (not JSON-stringified) — StreetEasy's server rejects string enums.
  const query = `query SearchSalesFederated {
  searchSales(input: {
    sorting: { attribute: LISTED_AT, direction: DESCENDING },
    filters: { areas: [${area}], saleStatus: ACTIVE },
    perPage: 10, page: 1
  }) {
    totalCount
    edges {
      ... on OrganicSaleEdge {
        node { id price street unit livingAreaSize bedroomCount fullBathroomCount urlPath daysOnMarket buildingType }
      }
    }
  }
}`;

  try {
    const r = await fetch("https://api-v6.streeteasy.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible)" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { listings: [], median_price: null, total: 0 };
    const d = await r.json();
    const result = d?.data?.searchSales;
    if (!result) return { listings: [], median_price: null, total: 0 };
    const listings: Listing[] = (result.edges || [])
      .map((e: any) => e?.node).filter(Boolean)
      .map((n: any) => ({
        address: [n.street, n.unit].filter(Boolean).join(" #"),
        price: Number(n.price)||0,
        beds: n.bedroomCount ?? null, baths: n.fullBathroomCount ?? null,
        sqft: n.livingAreaSize ?? null, days_on_market: n.daysOnMarket ?? null,
        url: n.urlPath ? `https://streeteasy.com${n.urlPath}` : "",
        building_type: n.buildingType || "",
      })).filter((l: Listing) => l.price > 0);
    const prices = listings.map(l=>l.price).sort((a,b)=>a-b);
    const median = prices.length ? prices[Math.floor(prices.length/2)] : null;
    return { listings, median_price: median, total: result.totalCount || 0 };
  } catch { return { listings: [], median_price: null, total: 0 }; }
}
const boroughFromZip = (z: string): string => {
  const n = Number(z);
  if (n >= 10001 && n <= 10282) return "1";
  if (n >= 10451 && n <= 10475) return "2";
  if (n >= 11201 && n <= 11256) return "3";
  if (n >= 11004 && n <= 11109 || n >= 11351 && n <= 11697) return "4";
  if (n >= 10301 && n <= 10314) return "5";
  return "";
};

const esc = (s: string) => String(s ?? "").replace(/'/g, "''");

async function soql(url: string, params: Record<string, string>): Promise<any[]> {
  const p = new URLSearchParams(params);
  if (TOKEN) p.set("$$app_token", TOKEN);
  try {
    const r = await fetch(`${url}?${p}`);
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

function mkBBL(b: string, blk: string, lt: string): string | null {
  const bd = String(b).replace(/\D/g,""),
        bk = String(blk).replace(/\D/g,"").padStart(5,"0"),
        l  = String(lt).replace(/\D/g,"").padStart(4,"0");
  return (bd && bk !== "00000" && l !== "0000") ? bd+bk+l : null;
}

type Prop = {
  bbl: string; address: string; zip: string;
  lien_stage: "none"|"active"|"final_sale";
  lien_type: string; lien_years: Set<number>;
  lis_pendens: boolean;
  hpd_c: number; ecb_balance: number;
  lot_area: number|null; bldg_class: string|null; year_built: string|null;
  num_bldgs: number|null; assess_tot: number|null;
  owner: string|null;
  score: number; signals: string[]; why: string;
  estate_type: "none"|"estate"|"executor"|"irrevocable_trust"|"trustee";
  joint_ownership: boolean;  // two individuals jointly own (potential couple)
  stalled_jobs: number;      // open construction jobs that are stalled/suspended/on-hold
  stop_work_orders: number;  // active stop work orders from DOB
  dob_violations: number;    // open DOB civil violations
};

type Sale = { address: string; amount: number; date: string; bbl: string };

export default async function handler() {
  if (!process.env.RESEND_API_KEY) { console.log("RESEND_API_KEY not set"); return; }
  if (!process.env.REPORT_EMAIL_TO) { console.log("REPORT_EMAIL_TO not set"); return; }
  console.log(`R Shark daily scan — ZIPs: ${ZIPS.join(", ")}`);

  for (const ZIP of ZIPS) {
    console.log(`\n── ZIP ${ZIP} ──`);
    const BORO = boroughFromZip(ZIP);

    // ── 1. Fetch all signals + live listings for this ZIP in parallel ─────────
    const [lienRows, hpdRows, ecbRows, plutoRows, liveListingsResult, dobJobRows, dobNowRows, dobViolRows] = await Promise.all([
      soql(LIEN, { $select:"borough,block,lot,house_number,street_name,zip_code,water_debt_only,cycle,month,building_class", $where:`zip_code='${esc(ZIP)}'`, $limit:"10000" }),
      soql(HPD,  { $select:"boroid,block,lot,boro", $where:`class='C' AND currentstatusid=2 AND zip='${esc(ZIP)}'`, $limit:"10000" }),
      soql(ECB,  { $select:"boro,block,lot,balance_due,respondent_zip", $where:`ecb_violation_status='ACTIVE' AND balance_due>0 AND respondent_zip='${esc(ZIP)}'`, $limit:"10000" }),
      soql(PLUTO, { $select:"bbl,address,ownername,lotarea,bldgclass,yearbuilt,numbldgs,assesstot", $where:`zipcode='${esc(ZIP)}'`, $limit:"50000" }),
      fetchListings(ZIP),
      // DOB BIS stalled jobs: status U=On Hold, H=Permit Renewal Pending (expired/stalled)
      soql(DOB_JOBS, { $select:"block,lot,borough,job__,job_type,job_status,job_status_descrp", $where:`zip_code='${esc(ZIP)}' AND (job_status='U' OR job_status='H') AND job_type='NB'`, $limit:"2000" }),
      // DOB NOW stalled/expired permits
      soql(DOB_NOW, { $select:"block,lot,borough,job__,job_type,job_status,stop_work_order", $where:`zip_code='${esc(ZIP)}' AND (job_status='STALLED' OR job_status='EXPIRED' OR stop_work_order='Y')`, $limit:"2000" }),
      // DOB civil violations (open, not resolved)
      soql(DOB_VIOL, { $select:"block,lot,boro,violation_type_code,issue_date,description", $where:`boro='${esc(BORO)}' AND disposition_date IS NULL`, $limit:"5000" }),
    ]);
    const { listings: liveListings, median_price: liveMedian, total: liveTotal } = liveListingsResult;

    // ── 2. Build PLUTO lookup map for fast enrichment ────────────────────────
    const plutoByBBL = new Map<string,any>();
    for (const r of plutoRows) {
      const bbl = String(r.bbl||"").split(".")[0].padStart(10,"0");
      plutoByBBL.set(bbl, r);
    }

    // ── 3. Aggregate all signals per BBL ────────────────────────────────────
    const props = new Map<string, Prop>();
    const get = (bbl: string, addr: string): Prop => {
      if (!props.has(bbl)) props.set(bbl, {
        bbl, address: addr, zip: ZIP,
        lien_stage:"none", lien_type:"", lien_years:new Set(),
        lis_pendens: false,
        hpd_c:0, ecb_balance:0,
        lot_area:null, bldg_class:null, year_built:null,
        num_bldgs:null, assess_tot:null, owner:null,
        score:0, signals:[], why:"",
        estate_type: "none",
        joint_ownership: false,
        stalled_jobs: 0, stop_work_orders: 0, dob_violations: 0,
      });
      return props.get(bbl)!;
    };

    // Liens
    for (const r of lienRows) {
      const bbl = mkBBL(String(r.borough), r.block, r.lot); if (!bbl) continue;
      const addr = [r.house_number, r.street_name].filter(Boolean).join(" ");
      const p = get(bbl, addr);
      const isFinal = String(r.cycle||"").toLowerCase().includes("final");
      if (isFinal) p.lien_stage = "final_sale";
      else if (p.lien_stage !== "final_sale") p.lien_stage = "active";
      p.lien_type = String(r.water_debt_only||"").toUpperCase()==="YES" ? "Water/sewer lien" : "Tax lien";
      if (r.month) p.lien_years.add(new Date(r.month).getFullYear());
    }
    // HPD Class C
    for (const r of hpdRows) {
      const bd = BORO_D[String(r.boro||"").toUpperCase().trim()] || String(r.boroid||"").replace(/\D/g,"");
      const bbl = mkBBL(bd, r.block, r.lot); if (!bbl) continue;
      get(bbl, bbl).hpd_c++;
    }
    // ECB fines
    for (const r of ecbRows) {
      const bbl = mkBBL(String(r.boro||""), r.block, r.lot); if (!bbl) continue;
      get(bbl, bbl).ecb_balance += Math.round(Number(r.balance_due)||0);
    }

    // DOB BIS stalled/on-hold construction jobs (NB = New Building)
    for (const r of dobJobRows) {
      const bbl = mkBBL(String(r.borough||BORO), r.block, r.lot); if (!bbl) continue;
      const p = props.get(bbl) || get(bbl, bbl);
      p.stalled_jobs++;
    }
    // DOB NOW stalled/expired + stop work orders
    for (const r of dobNowRows) {
      const bbl = mkBBL(String(r.borough||BORO), r.block, r.lot); if (!bbl) continue;
      const p = props.get(bbl) || get(bbl, bbl);
      if (String(r.stop_work_order||"").toUpperCase()==="Y") p.stop_work_orders++;
      else p.stalled_jobs++;
    }
    // DOB civil violations
    for (const r of dobViolRows) {
      const bbl = mkBBL(String(r.boro||BORO), r.block, r.lot); if (!bbl) continue;
      const p = props.get(bbl); if (!p) continue; // only enrich existing distressed props
      p.dob_violations++;
    }

    if (!props.size) { console.log(`ZIP ${ZIP}: no distressed properties`); continue; }

    // ── 4. Enrich from PLUTO lookup map ──────────────────────────────────────
    for (const p of props.values()) {
      const pl = plutoByBBL.get(p.bbl);
      if (!pl) continue;
      if (pl.address)   p.address    = pl.address;
      if (pl.ownername) p.owner      = pl.ownername;
      p.lot_area   = pl.lotarea   ? Math.round(Number(pl.lotarea))  : null;
      p.bldg_class = pl.bldgclass || null;
      p.year_built = pl.yearbuilt || null;
      p.num_bldgs  = pl.numbldgs  != null ? Number(pl.numbldgs) : null;
      p.assess_tot = pl.assesstot ? Math.round(Number(pl.assesstot)) : null;

      // Detect estate/trust ownership from ownername
      if (p.owner) {
        const n = p.owner.toUpperCase();
        if (/ESTATE OF/.test(n))
          p.estate_type = "estate";
        else if (/EXECUTOR|ADMINISTRATOR OF ESTATE|ADMINISTRATRIX/.test(n))
          p.estate_type = "executor";
        else if (/IRREVOCABLE TRUST/.test(n))
          p.estate_type = "irrevocable_trust";
        else if (/AS TRUSTEE|TRUSTEE OF|, TRUSTEE/.test(n))
          p.estate_type = "trustee";

        // Detect joint individual ownership (two people = potential couple).
        // Pattern: "JOHN SMITH AND JANE SMITH" or "JOHN & JANE SMITH"
        // Exclude LLCs, corps, trusts, estates.
        const isEntity = /LLC|CORP|INC|TRUST|ESTATE|ASSOC|REALTY|PROP|MGMT|HOLDINGS|GROUP/.test(n);
        if (!isEntity && (/ AND | & /.test(n))) {
          // Make sure it looks like two people (has first names, not two companies)
          const parts = n.split(/ AND | & /);
          if (parts.length === 2 && parts.every(p => p.trim().length > 3 && !/LLC|CORP|INC/.test(p)))
            p.joint_ownership = true;
        }

        // Also check if "DIVORCED" appears explicitly (from ACRIS deed transfer)
        if (/DIVORCED|A\/K\/A.*DIVORCED|N\/K\/A.*DIVORCED/.test(n)) {
          p.joint_ownership = true; // treat as couple separation signal
        }
      }
    }

    // ── 5. Lis pendens — check ACRIS for foreclosure filings ─────────────────
    // Query ACRIS legals for this ZIP, then cross-reference with master for LP docs.
    // We only do this for BBLs that already have distress signals (keeps query small).
    if (BORO) {
      const acrisBBLs = [...props.keys()].slice(0, 200);
      const blockLots = acrisBBLs.map(bbl => `(borough='${esc(BORO)}' AND block='${String(Number(bbl.slice(1,6)))}' AND lot='${String(Number(bbl.slice(6)))}')`).join(" OR ");
      if (blockLots) {
        const legalDocs = await soql(ACRIS_LEGAL, { $select:"document_id,borough,block,lot", $where:blockLots, $limit:"2000" });
        if (legalDocs.length) {
          const docIds = legalDocs.map(d=>d.document_id).filter(Boolean);
          // Batch check master for LP doc types
          const CHUNK = 100;
          const lpDocIds = new Set<string>();
          for (let i = 0; i < docIds.length; i += CHUNK) {
            const chunk = docIds.slice(i, i+CHUNK).map(id=>`'${esc(id)}'`).join(",");
            const masterDocs = await soql(ACRIS_MASTER, { $select:"document_id,doc_type,document_date", $where:`document_id in(${chunk}) AND (doc_type='LP' OR doc_type='LIS PENDEN' OR doc_type='NOTICE OF PENDENCY')`, $limit:"500" });
            for (const d of masterDocs) lpDocIds.add(d.document_id);
          }
          // Map LP docs back to BBLs
          for (const d of legalDocs) {
            if (!lpDocIds.has(d.document_id)) continue;
            const bbl = mkBBL(d.borough, String(d.block).padStart(5,"0"), String(d.lot).padStart(4,"0"));
            if (bbl && props.has(bbl)) props.get(bbl)!.lis_pendens = true;
          }
        }
      }
    }

    // ── 6. Fetch recent sales in this ZIP for market comparison ──────────────
    // ACRIS legals → get deed document_ids for this ZIP → master for amounts
    let recentSales: Sale[] = [];
    if (BORO) {
      const cutoff = new Date(Date.now() - 180*24*3600*1000).toISOString().slice(0,10); // last 6 months
      const deedLegals = await soql(ACRIS_LEGAL, {
        $select:"document_id,block,lot,street_number,street_name",
        $where:`borough='${esc(BORO)}' AND street_name IS NOT NULL`,
        $limit:"500",
      });
      if (deedLegals.length) {
        const deedIds = deedLegals.map(d=>d.document_id).filter(Boolean);
        const CHUNK = 100;
        for (let i = 0; i < deedIds.length; i += CHUNK) {
          const chunk = deedIds.slice(i,i+CHUNK).map(id=>`'${esc(id)}'`).join(",");
          const sales = await soql(ACRIS_MASTER, {
            $select:"document_id,doc_type,document_date,document_amt",
            $where:`document_id in(${chunk}) AND (doc_type='DEED' OR doc_type='DEEDO') AND document_amt>50000 AND document_date>='${cutoff}'`,
            $limit:"200",
          });
          for (const s of sales) {
            const leg = deedLegals.find(d=>d.document_id===s.document_id);
            if (!leg) continue;
            const bbl = mkBBL(BORO, String(leg.block||"").padStart(5,"0"), String(leg.lot||"").padStart(4,"0")) || "";
            recentSales.push({
              address: [leg.street_number, leg.street_name].filter(Boolean).join(" "),
              amount: Math.round(Number(s.document_amt)),
              date: String(s.document_date||"").slice(0,10),
              bbl,
            });
          }
        }
        recentSales = recentSales.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);
      }
    }

    // ── 7. Score every property ───────────────────────────────────────────────
    for (const p of props.values()) {
      let s = 0; const sig: string[] = [];

      // Financial distress
      if (p.lien_stage === "final_sale") { s += 40; sig.push("⚠️ Lien SOLD at auction"); }
      else if (p.lien_stage === "active") { s += 20; sig.push(p.lien_type); }
      if (p.lien_type === "Water/sewer lien") { s += 10; sig.push("No water usage — likely vacant"); }
      if (p.lien_years.size >= 3)      { s += 15; sig.push(`Chronic: on lien list ${p.lien_years.size} years`); }
      else if (p.lien_years.size === 2) { s += 8;  sig.push("On lien list 2 years"); }

      // Legal pressure
      if (p.lis_pendens) { s += 35; sig.push("🏛️ Lis pendens filed (foreclosure action)"); }

      // Code violations
      if (p.hpd_c > 0)        { const pts = Math.min(p.hpd_c*5,20);              s += pts; sig.push(`${p.hpd_c} open HPD Class C violation${p.hpd_c>1?"s":""}`); }
      if (p.ecb_balance > 0)  { const pts = Math.min(Math.floor(p.ecb_balance/1000),15); s += pts; sig.push(`$${p.ecb_balance.toLocaleString()} unpaid DOB fines`); }
      if (p.dob_violations > 0) { const pts = Math.min(p.dob_violations * 3, 12); s += pts; sig.push(`${p.dob_violations} open DOB civil violation${p.dob_violations>1?"s":""}`); }

      // Stalled construction — developer out of money or stuck
      if (p.stop_work_orders > 0) {
        s += 30; sig.push(`🚧 Stop Work Order issued — construction halted by DOB`);
      }
      if (p.stalled_jobs > 0 && p.stop_work_orders === 0) {
        s += 20; sig.push(`🚧 ${p.stalled_jobs} stalled construction permit${p.stalled_jobs>1?"s":""} (on hold / expired)`);
      }

      // Property signals
      const isVacantLot = p.num_bldgs === 0 || p.bldg_class?.startsWith("V");
      if (isVacantLot)                 { s += 15; sig.push("Vacant lot — pure carrying cost, no income"); }
      if ((p.lot_area||0) >= 5000)     { s += 5;  sig.push(`${p.lot_area!.toLocaleString()} sf lot`); }
      // Low assessed value relative to lot size → likely older owner, hasn't refinanced
      if (p.lot_area && p.assess_tot && p.assess_tot > 0 && (p.assess_tot / p.lot_area) < 30) {
        s += 5; sig.push("Low assessed value vs lot size — likely long-hold owner");
      }

      // Estate / trust / joint ownership
      if (p.estate_type === "estate") {
        s += 15; sig.push("🪦 Owner deceased — ESTATE OF " + (p.owner||"").replace(/ESTATE OF /i,"").split(",")[0]);
      } else if (p.estate_type === "executor") {
        s += 20; sig.push("⚖️ Executor/administrator — probate in progress, heirs want to liquidate");
      } else if (p.estate_type === "irrevocable_trust") {
        s += 8; sig.push("📋 Irrevocable trust — often indicates owner incapacitated or deceased");
      } else if (p.estate_type === "trustee") {
        s += 3; sig.push("📋 Held in trust");
      }

      // Joint individual ownership — potential couple, higher motivation when combined with distress
      if (p.joint_ownership) {
        // Alone: weak signal (+5). With any financial distress: much stronger (+15).
        const hasDistress = p.lien_stage !== "none" || p.lis_pendens || p.ecb_balance > 0 || p.stalled_jobs > 0;
        if (hasDistress) {
          s += 15; sig.push("👫 Joint ownership + financial distress — couple likely needs to resolve and split proceeds");
        } else {
          s += 5; sig.push("👫 Joint individual ownership — two people, easier to motivate toward a sale");
        }
      }

      p.score = Math.min(s, 100);
      p.signals = sig;

      // Human-readable why
      if (p.stop_work_orders > 0 && (p.lien_stage !== "none" || p.ecb_balance > 0))
        p.why = `Stop Work Order + financial distress — construction is halted by DOB and the developer has mounting debt. Extremely motivated to exit.`;
      else if (p.stop_work_orders > 0)
        p.why = "Stop Work Order issued — construction halted by DOB. Developer cannot proceed, likely needs to sell to recoup.";
      else if (p.stalled_jobs > 0 && p.lien_stage !== "none")
        p.why = "Stalled construction + tax lien — developer ran out of money and can't pay carrying costs. Motivated to exit at a discount.";
      else if (p.stalled_jobs > 0 && p.ecb_balance > 5000)
        p.why = `Stalled construction + $${p.ecb_balance.toLocaleString()} in unpaid DOB fines — project is stuck with no path forward.`;
      else if (p.stalled_jobs > 0)
        p.why = "Stalled construction permit — developer unable to complete the project. Site sitting idle while carrying costs mount.";
      else if (p.lis_pendens && p.lien_stage === "final_sale")
        p.why = "Court foreclosure + lien sold — owner has lost near-total control. Maximum motivation to exit on any terms.";
      else if (p.estate_type === "executor" && p.lien_stage !== "none")
        p.why = "Estate in probate + active tax lien — heirs are legally obligated to resolve debts. Strong motivation to close quickly.";
      else if (p.estate_type === "executor")
        p.why = "Executor managing estate — heirs want to distribute proceeds, not manage real estate. Probate courts push for timely resolution.";
      else if (p.estate_type === "estate" && p.lien_stage !== "none")
        p.why = `Owner deceased, estate has ${p.lien_type||"tax lien"} — heirs face mounting costs with no income. Highly motivated.`;
      else if (p.estate_type === "estate")
        p.why = "Owner deceased — heirs typically lack attachment to the property and want to convert to cash.";
      else if (p.lis_pendens)
        p.why = "Lis pendens filed — foreclosure action is underway in court. Owner needs a deal before judgment.";
      else if (p.lien_stage === "final_sale" && p.hpd_c > 0)
        p.why = `Lien sold at auction + ${p.hpd_c} code violations — owner is overwhelmed and out of options.`;
      else if (p.lien_stage === "final_sale")
        p.why = "Lien sold at auction — owner under maximum legal pressure. Likely open to any exit that clears the debt.";
      else if (p.lien_years.size >= 3 && p.hpd_c > 0)
        p.why = `${p.lien_years.size} years of tax arrears + ${p.hpd_c} open violations — owner unable or unwilling to manage this property.`;
      else if (p.lien_years.size >= 3)
        p.why = `${p.lien_years.size} consecutive years on the lien list — chronic, not a one-time slip. Owner is financially stuck.`;
      else if (p.estate_type === "irrevocable_trust" && p.lien_stage !== "none")
        p.why = "Irrevocable trust with tax lien — trustee has fiduciary duty to resolve debts, sale is path of least resistance.";
      else if (p.lien_years.size === 2 && p.ecb_balance > 5000)
        p.why = `2 years of liens + $${p.ecb_balance.toLocaleString()} in unpaid DOB fines — multiple layers of financial pressure.`;
      else if (isVacantLot && p.lien_stage !== "none")
        p.why = "Vacant lot with tax lien — owner paying to hold nothing. Every month is a net loss with no income.";
      else if (p.hpd_c >= 4)
        p.why = `${p.hpd_c} immediately hazardous violations — liability mounting. Owner risks DHCR action.`;
      else if (p.ecb_balance > 10000)
        p.why = `$${p.ecb_balance.toLocaleString()} in unpaid city fines — compounds and can result in judgment liens.`;
      else if (p.joint_ownership && p.lien_stage !== "none")
        p.why = "Joint owners with tax/water lien — two people splitting carrying costs. Disagreements on who pays accelerate motivation to sell.";
      else if (p.joint_ownership && (p.hpd_c > 2 || p.ecb_balance > 5000))
        p.why = "Joint owners with code violations and fines — shared liability creates pressure on both parties to exit.";
      else
        p.why = "Multiple public distress signals — owner is under financial and/or legal pressure.";
    }

    // ── 8. Rank top 25 for this ZIP ──────────────────────────────────────────
    const top = [...props.values()].filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,25);
    if (!top.length) { console.log(`ZIP ${ZIP}: nothing scored`); continue; }

    console.log(`ZIP ${ZIP}: ${props.size} distressed, top score ${top[0].score} (${top[0].address}), ${top.filter(p=>p.score>=60).length} HOT`);

    // ── 9. Build HTML email ───────────────────────────────────────────────────
    const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    const scoreBar = (s:number) => {
      const c=s>=60?"#FF4B3E":s>=35?"#FFB03A":"#2FE0C6", lbl=s>=60?"HOT":s>=35?"WATCH":"TRACK";
      return `<span style="background:${c};color:#0A0E14;padding:3px 10px;border-radius:999px;font-weight:700;font-size:12px">${s} ${lbl}</span>`;
    };

    const tableRows = top.map((p,i)=>`
      <tr style="border-bottom:1px solid #1C2532;vertical-align:top">
        <td style="padding:14px 8px;text-align:center;color:#8A97A8;font-size:13px;white-space:nowrap">${i+1}</td>
        <td style="padding:14px 8px">
          <a href="https://rshark.net/?bbl=${p.bbl}" style="color:#EAF0F6;font-weight:700;font-size:15px;text-decoration:none">${p.address||p.bbl}</a>
          ${p.owner?`<span style="color:#8A97A8;font-size:12px"> · ${p.owner}</span>`:""}
          <div style="color:#2FE0C6;font-size:12px;margin-top:5px;font-style:italic">${p.why}</div>
          <div style="margin-top:6px">${p.signals.map(sig=>`<span style="background:#1C2532;color:#8A97A8;font-size:11px;padding:2px 8px;border-radius:4px;margin:2px 2px 2px 0;display:inline-block">${sig}</span>`).join("")}</div>
          <div style="color:#8A97A8;font-size:11px;margin-top:5px">BBL: ${p.bbl}${p.bldg_class?` · Class ${p.bldg_class}`:""}${p.year_built&&p.year_built!="0"?` · Built ${p.year_built}`:""}${p.lot_area?` · ${p.lot_area.toLocaleString()} sf`:""}</div>
        </td>
        <td style="padding:14px 8px;text-align:right;white-space:nowrap">${scoreBar(p.score)}</td>
      </tr>`).join("");

    const salesRows = recentSales.length ? recentSales.map(s=>`
      <tr style="border-bottom:1px solid #1C2532">
        <td style="padding:10px 8px;color:#EAF0F6;font-size:13px">
          ${s.bbl?`<a href="https://rshark.net/?bbl=${s.bbl}" style="color:#EAF0F6;text-decoration:none">`:""}${s.address||s.bbl}${s.bbl?"</a>":""}
        </td>
        <td style="padding:10px 8px;text-align:right;color:#2FE0C6;font-size:13px;font-weight:700;white-space:nowrap">$${s.amount.toLocaleString()}</td>
        <td style="padding:10px 8px;text-align:right;color:#8A97A8;font-size:11px;white-space:nowrap">${s.date}</td>
      </tr>`).join("") : `<tr><td colspan="3" style="padding:12px 8px;color:#8A97A8;font-size:13px">No deed transfers found in last 6 months</td></tr>`;

    // Live listings rows from StreetEasy
    const liveRows = liveListings.length ? liveListings.map(l=>`
      <tr style="border-bottom:1px solid #1C2532">
        <td style="padding:10px 8px">
          <a href="${l.url}" style="color:#EAF0F6;font-size:13px;text-decoration:none">${l.address||"—"}</a>
          <span style="color:#8A97A8;font-size:11px;margin-left:6px">${l.building_type}</span>
          <div style="color:#8A97A8;font-size:11px;margin-top:2px">${[l.beds!=null?l.beds+'bd':null,l.baths!=null?l.baths+'ba':null,l.sqft?l.sqft.toLocaleString()+' sf':null].filter(Boolean).join(' · ')}</div>
        </td>
        <td style="padding:10px 8px;text-align:right;color:#2FE0C6;font-size:13px;font-weight:700;white-space:nowrap">$${l.price.toLocaleString()}</td>
        <td style="padding:10px 8px;text-align:right;color:#8A97A8;font-size:11px;white-space:nowrap">${l.days_on_market!=null?l.days_on_market+'d on mkt':''}</td>
      </tr>`).join("") : `<tr><td colspan="3" style="padding:12px 8px;color:#8A97A8;font-size:13px">No active listings found on StreetEasy for this area</td></tr>`;

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0A0E14;font-family:system-ui,sans-serif">
<div style="max-width:720px;margin:0 auto;padding:32px 16px">

  <!-- Header -->
  <table style="width:100%;margin-bottom:8px"><tr>
    <td><table><tr>
      <td style="padding-right:12px"><svg width="44" height="34" viewBox="0 0 110 84">
        <path d="M72 52 C 56 50,44 42,41 14 C 30 30,22 42,16 52 C 30 52,52 52,72 52Z" fill="#2FE0C6"/>
        <path d="M 14 6 C 12 20,13 38,12 62" fill="none" stroke="white" stroke-width="8.5" stroke-linecap="round"/>
        <path d="M 14 6 C 26 1,58 4,68 20 C 78 36,66 52,14 52" fill="none" stroke="white" stroke-width="8.5" stroke-linecap="round"/>
        <path d="M 36 52 C 58 56,80 60,98 64" fill="none" stroke="white" stroke-width="7.5" stroke-linecap="round"/>
        <path d="M 98 64 C 103 60,104 54,100 50" fill="none" stroke="white" stroke-width="5.5" stroke-linecap="round"/>
      </svg></td>
      <td><span style="color:#EAF0F6;font-size:26px;font-weight:700;letter-spacing:-0.02em">R SHARK</span></td>
    </tr></table></td>
    <td style="text-align:right;color:#8A97A8;font-size:13px;vertical-align:bottom">
      ZIP ${ZIP} · ${BORO_NAME[BORO]||""}<br>${today}
    </td>
  </tr></table>

  <!-- Stats strip -->
  <div style="background:#141B26;border-radius:10px;padding:16px 20px;margin-bottom:20px">
    <table style="width:100%"><tr>
      <td style="color:#EAF0F6;font-size:14px"><strong>ZIP ${ZIP}</strong> · ${props.size.toLocaleString()} distressed properties</td>
      <td style="text-align:right">
        <span style="background:#FF4B3E;color:#0A0E14;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700">${top.filter(p=>p.score>=60).length} HOT</span>&nbsp;
        <span style="background:#FFB03A;color:#0A0E14;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700">${top.filter(p=>p.score>=35&&p.score<60).length} WATCH</span>
      </td>
    </tr></table>
  </div>

  <!-- Score key -->
  <div style="margin-bottom:14px;font-size:11px;color:#8A97A8">
    <strong>Score model:</strong>
    Lien at auction (+40) · Active lien (+20) · Lis pendens/foreclosure (+35) · Chronic 3yr lien (+15) ·
    HPD Class C (+5 each) · ECB fines (+$1k) · Stop Work Order (+30) · Stalled permit (+20) · Vacant lot (+15) · Large lot (+5) · Low assessed value (+5)
  </div>

  <!-- Motivated sellers table -->
  <div style="background:#141B26;border-radius:12px;overflow:hidden;margin-bottom:28px">
    <div style="padding:12px 16px;border-bottom:1px solid #28323F;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em">
      Top ${top.length} Motivated Sellers — ranked by seller pressure score
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #28323F">
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;text-align:center">#</th>
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;text-align:left">Property · Why They'll Sell</th>
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;text-align:right">Score</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  <!-- Live listings: what's ON MARKET right now -->
  <div style="background:#141B26;border-radius:12px;overflow:hidden;margin-bottom:16px">
    <div style="padding:12px 16px;border-bottom:1px solid #28323F">
      <span style="color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em">🏠 Active Listings — StreetEasy</span>
      ${liveTotal>0?`<span style="float:right;color:#2FE0C6;font-size:11px">${liveTotal.toLocaleString()} active · ${liveMedian?'median $'+liveMedian.toLocaleString():''}</span>`:''}
    </div>
    <div style="padding:8px 16px;color:#8A97A8;font-size:12px;border-bottom:1px solid #1C2532">
      What asking prices look like <em>right now</em>. Compare against your distressed leads to gauge the discount you're getting.
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #28323F">
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:left">Listing (StreetEasy)</th>
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:right">Ask Price</th>
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:right">Days on Mkt</th>
      </tr></thead>
      <tbody>${liveRows}</tbody>
    </table>
  </div>

  <!-- Closed sales: what's actually transacted -->
  <div style="background:#141B26;border-radius:12px;overflow:hidden;margin-bottom:24px">
    <div style="padding:12px 16px;border-bottom:1px solid #28323F;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em">
      📋 Recent Closed Sales — ACRIS (last 6 months)
    </div>
    <div style="padding:8px 16px;color:#8A97A8;font-size:12px;border-bottom:1px solid #1C2532">
      Actual recorded deed transfers. This is what buyers actually paid — not ask prices. Use to anchor your offer logic.
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #28323F">
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:left">Address</th>
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:right">Closed Price</th>
        <th style="padding:8px;color:#8A97A8;font-size:11px;text-align:right">Date</th>
      </tr></thead>
      <tbody>${salesRows}</tbody>
    </table>
  </div>

  <p style="color:#28323F;font-size:11px;text-align:center;margin-top:20px">
    R Shark · All data from NYC public records + StreetEasy. Informational only — not legal or investment advice. Verify before acting.
  </p>
</div></body></html>`;

    // ── 10. Send ──────────────────────────────────────────────────────────────
    const res = await fetch(RESEND, {
      method:"POST",
      headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
      body: JSON.stringify({
        from: process.env.REPORT_EMAIL_FROM||"R Shark <reports@rshark.net>",
        to:   [process.env.REPORT_EMAIL_TO!],
        subject: `🦈 ZIP ${ZIP} — ${top.filter(p=>p.score>=60).length} HOT · ${top.length} motivated sellers · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`,
        html,
      }),
    });
    const result = await res.json();
    console.log(`ZIP ${ZIP} email sent. ID: ${result.id||"?"}`);

    await new Promise(r=>setTimeout(r,400)); // be kind to Resend API
  }
}

export const config: Config = {
  schedule: "0 11 * * *",  // 7 AM ET = 11 AM UTC
};
