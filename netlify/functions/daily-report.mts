import type { Config } from "@netlify/functions";

// ── R Shark: Daily Seller-Motivation Report ─────────────────────────────────
// Runs 7 AM ET daily. Finds properties where the OWNER is likely ready to sell
// based on financial pressure signals from NYC public data.
//
// SCORING MODEL — "Motivated Seller Index" (0–100):
//   Lien at Final Sale stage (sold at auction)      +40  ← strongest signal
//   Lien present (not yet sold)                     +20
//   Water lien (vacant/non-income property)         +10 bonus
//   Multi-year lien (appears in 2+ years)           +15  ← chronic distress
//   HPD Class C violations (hazardous)              +5 each, max +20
//   ECB unpaid balance                              +1 per $1k, max +15
//   Vacant lot (carrying cost, no income)           +15
//   Large lot >5000 sf (more upside = easier sell)  +5
//
// Required env vars (Netlify → Site configuration → Environment variables):
//   RESEND_API_KEY      from resend.com (free tier)
//   REPORT_EMAIL_TO     e.g. roeipaz@gmail.com
//   REPORT_EMAIL_FROM   e.g. reports@rshark.net (must be verified in Resend)
//   REPORT_ZIPS         comma-separated: 11238,10036,11201
//   SOCRATA_APP_TOKEN   already set

const PLUTO = "https://data.cityofnewyork.us/resource/64uk-42ks.json";
const LIEN  = "https://data.cityofnewyork.us/resource/9rz4-mjek.json";
const HPD   = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";
const ECB   = "https://data.cityofnewyork.us/resource/6bgk-3dad.json";
const RESEND = "https://api.resend.com/emails";

const TOKEN = process.env.SOCRATA_APP_TOKEN;
const ZIPS  = (process.env.REPORT_ZIPS || "11238").split(",").map(z => z.trim()).filter(Boolean);

const esc = (s: string) => String(s ?? "").replace(/'/g, "''");

async function soql(url: string, params: Record<string, string>): Promise<any[]> {
  const p = new URLSearchParams(params);
  if (TOKEN) p.set("$$app_token", TOKEN);
  try {
    const r = await fetch(`${url}?${p}`);
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

const BORO: Record<string, string> = {
  MANHATTAN:"1", BRONX:"2", BROOKLYN:"3", QUEENS:"4", "STATEN ISLAND":"5"
};
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
  hpd_c: number; ecb_balance: number;
  lot_area: number|null; bldg_class: string|null; year_built: string|null;
  owner: string|null;
  score: number; signals: string[]; why: string;
};

export default async function handler() {
  if (!process.env.RESEND_API_KEY) { console.log("RESEND_API_KEY not set"); return; }
  if (!process.env.REPORT_EMAIL_TO) { console.log("REPORT_EMAIL_TO not set"); return; }

  console.log(`R Shark seller-motivation scan — ZIPs: ${ZIPS.join(", ")}`);

  // Process each ZIP independently and send a separate email per ZIP.
  for (const ZIP of ZIPS) {
    console.log(`Processing ZIP ${ZIP}...`);

    // ── Fetch all distress signals for this ZIP in parallel ─────────────────
    const [lienRows, hpdRows, ecbRows] = await Promise.all([
      soql(LIEN, {
        $select: "borough,block,lot,house_number,street_name,zip_code,water_debt_only,cycle,month,building_class",
        $where: `zip_code='${esc(ZIP)}'`,
        $limit: "10000",
      }),
      soql(HPD, {
        $select: "boroid,block,lot,boro",
        $where: `class='C' AND currentstatusid=2 AND zip='${esc(ZIP)}'`,
        $limit: "10000",
      }),
      soql(ECB, {
        $select: "boro,block,lot,balance_due,respondent_zip",
        $where: `ecb_violation_status='ACTIVE' AND balance_due>0 AND respondent_zip='${esc(ZIP)}'`,
        $limit: "10000",
      }),
    ]);

    // ── Aggregate per BBL ──────────────────────────────────────────────────
    const props = new Map<string, Prop>();
    const get = (bbl: string, addr: string, zip: string): Prop => {
      if (!props.has(bbl)) props.set(bbl, {
        bbl, address: addr, zip,
        lien_stage: "none", lien_type: "", lien_years: new Set(),
        hpd_c: 0, ecb_balance: 0,
        lot_area: null, bldg_class: null, year_built: null, owner: null,
        score: 0, signals: [], why: "",
      });
      return props.get(bbl)!;
    };

    for (const r of lienRows) {
      const bbl = mkBBL(String(r.borough), r.block, r.lot); if (!bbl) continue;
      const addr = [r.house_number, r.street_name].filter(Boolean).join(" ");
      const p = get(bbl, addr, r.zip_code || ZIP);
      const isFinal = String(r.cycle||"").toLowerCase().includes("final");
      if (isFinal) p.lien_stage = "final_sale";
      else if (p.lien_stage !== "final_sale") p.lien_stage = "active";
      p.lien_type = String(r.water_debt_only||"").toUpperCase()==="YES" ? "Water/sewer lien" : "Tax lien";
      if (r.month) p.lien_years.add(new Date(r.month).getFullYear());
    }
    for (const r of hpdRows) {
      const bd = BORO[String(r.boro||"").toUpperCase().trim()] || String(r.boroid||"").replace(/\D/g,"");
      const bbl = mkBBL(bd, r.block, r.lot); if (!bbl) continue;
      get(bbl, bbl, ZIP).hpd_c++;
    }
    for (const r of ecbRows) {
      const bbl = mkBBL(String(r.boro||""), r.block, r.lot); if (!bbl) continue;
      get(bbl, bbl, ZIP).ecb_balance += Math.round(Number(r.balance_due)||0);
    }

    if (!props.size) { console.log(`ZIP ${ZIP}: no distressed properties`); continue; }

    // ── Enrich with PLUTO ────────────────────────────────────────────────────
    const bbls = [...props.keys()];
    const CHUNK = 100;
    for (let i = 0; i < bbls.length; i += CHUNK) {
      const chunk = bbls.slice(i, i+CHUNK);
      const rows = await soql(PLUTO, {
        $select: "bbl,address,ownername,lotarea,bldgclass,yearbuilt",
        $where: `bbl in(${chunk.map(Number).join(",")})`,
        $limit: "500",
      });
      for (const r of rows) {
        const bbl = String(r.bbl||"").split(".")[0].padStart(10,"0");
        const p = props.get(bbl); if (!p) continue;
        if (r.address)   p.address   = r.address;
        if (r.ownername) p.owner     = r.ownername;
        p.lot_area   = r.lotarea   ? Math.round(Number(r.lotarea))  : null;
        p.bldg_class = r.bldgclass || null;
        p.year_built = r.yearbuilt || null;
      }
    }

    // ── Score ────────────────────────────────────────────────────────────────
    for (const p of props.values()) {
      let s = 0; const sig: string[] = [];
      if (p.lien_stage === "final_sale") { s += 40; sig.push("⚠️ Lien SOLD at auction"); }
      else if (p.lien_stage === "active") { s += 20; sig.push(p.lien_type); }
      if (p.lien_type === "Water/sewer lien") { s += 10; sig.push("No water usage — likely vacant"); }
      if (p.lien_years.size >= 3) { s += 15; sig.push(`On lien list ${p.lien_years.size} years (chronic)`); }
      else if (p.lien_years.size === 2) { s += 8; sig.push("On lien list 2 years"); }
      if (p.hpd_c > 0) { const pts = Math.min(p.hpd_c*5,20); s += pts; sig.push(`${p.hpd_c} open HPD Class C violation${p.hpd_c>1?"s":""}`); }
      if (p.ecb_balance > 0) { const pts = Math.min(Math.floor(p.ecb_balance/1000),15); s += pts; sig.push(`$${p.ecb_balance.toLocaleString()} unpaid DOB fines`); }
      if (p.bldg_class?.startsWith("V")) { s += 15; sig.push("Vacant lot"); }
      if ((p.lot_area||0) >= 5000) { s += 5; sig.push(`${p.lot_area!.toLocaleString()} sf lot`); }
      p.score = Math.min(s, 100); p.signals = sig;
      if (p.lien_stage === "final_sale") p.why = "Lien sold at auction — owner under maximum legal pressure, likely open to any exit.";
      else if (p.lien_years.size >= 3 && p.hpd_c > 0) p.why = `${p.lien_years.size} years of tax arrears + ${p.hpd_c} code violations — owner unable or unwilling to manage.`;
      else if (p.lien_years.size >= 2) p.why = "Multi-year lien — not a one-time slip, owner chronically behind.";
      else if (p.bldg_class?.startsWith("V") && p.lien_stage !== "none") p.why = "Vacant lot with tax lien — owner paying to hold nothing.";
      else if (p.hpd_c >= 3) p.why = `${p.hpd_c} hazardous violations — building liability mounting.`;
      else p.why = "Multiple distress signals — owner under financial pressure.";
    }

    // ── Rank top 25 for this ZIP ─────────────────────────────────────────────
    const top = [...props.values()].filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,25);
    if (!top.length) { console.log(`ZIP ${ZIP}: nothing scored`); continue; }

    // ── Build email ──────────────────────────────────────────────────────────
    const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    const scoreBar = (s:number) => {
      const color = s>=60?"#FF4B3E":s>=35?"#FFB03A":"#2FE0C6";
      const label = s>=60?"HOT":s>=35?"WATCH":"TRACK";
      return `<span style="background:${color};color:#0A0E14;padding:3px 10px;border-radius:999px;font-weight:700;font-size:12px">${s} ${label}</span>`;
    };
    const tableRows = top.map((p,i)=>`
      <tr style="border-bottom:1px solid #1C2532;vertical-align:top">
        <td style="padding:14px 8px;text-align:center;color:#8A97A8;font-size:13px;white-space:nowrap">${i+1}</td>
        <td style="padding:14px 8px">
          <a href="https://rshark.net/?bbl=${p.bbl}" style="color:#EAF0F6;font-weight:700;font-size:15px;text-decoration:none">${p.address||p.bbl}</a>
          ${p.owner?`<span style="color:#8A97A8;font-size:12px"> · ${p.owner}</span>`:""}
          <div style="color:#2FE0C6;font-size:12px;margin-top:5px;font-style:italic">${p.why}</div>
          <div style="margin-top:6px">${p.signals.map(s=>`<span style="background:#1C2532;color:#8A97A8;font-size:11px;padding:2px 8px;border-radius:4px;margin:2px 2px 2px 0;display:inline-block">${s}</span>`).join("")}</div>
          <div style="color:#8A97A8;font-size:11px;margin-top:5px">BBL: ${p.bbl}${p.bldg_class?` · Class ${p.bldg_class}`:""}${p.year_built?` · Built ${p.year_built}`:""}</div>
        </td>
        <td style="padding:14px 8px;text-align:right;white-space:nowrap">${scoreBar(p.score)}</td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0A0E14;font-family:system-ui,sans-serif">
<div style="max-width:700px;margin:0 auto;padding:32px 16px">
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
    <td style="text-align:right;color:#8A97A8;font-size:13px;vertical-align:bottom">ZIP ${ZIP} · Motivated Sellers<br>${today}</td>
  </tr></table>
  <div style="background:#141B26;border-radius:10px;padding:16px 20px;margin-bottom:20px">
    <table style="width:100%"><tr>
      <td style="color:#EAF0F6;font-size:14px"><strong>ZIP ${ZIP}</strong><span style="color:#8A97A8"> · ${props.size.toLocaleString()} distressed properties found</span></td>
      <td style="text-align:right;color:#8A97A8;font-size:13px">Top ${top.length} by seller motivation</td>
    </tr></table>
  </div>
  <div style="margin-bottom:14px">
    <span style="color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-right:8px">Score:</span>
    <span style="background:#FF4B3E;color:#0A0E14;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;margin-right:4px">60+ HOT</span>
    <span style="background:#FFB03A;color:#0A0E14;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;margin-right:4px">35+ WATCH</span>
    <span style="background:#2FE0C6;color:#0A0E14;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700">TRACK</span>
  </div>
  <div style="background:#141B26;border-radius:12px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #28323F">
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:center">#</th>
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:left">Property &amp; Why They'll Sell</th>
        <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:right">Score</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
  <p style="color:#28323F;font-size:11px;text-align:center;margin-top:20px">R Shark · Informational only. Verify all data before acting.</p>
</div></body></html>`;

    // ── Send ─────────────────────────────────────────────────────────────────
    const res = await fetch(RESEND, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.REPORT_EMAIL_FROM || "R Shark <reports@rshark.net>",
        to: [process.env.REPORT_EMAIL_TO!],
        subject: `🦈 ZIP ${ZIP} — ${top.filter(p=>p.score>=60).length} HOT · ${top.length} motivated sellers · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`,
        html,
      }),
    });
    const result = await res.json();
    console.log(`ZIP ${ZIP}: sent. Top score ${top[0]?.score} (${top[0]?.address}). ID: ${result.id||"?"}`);

    // Small pause between emails to be kind to the API
    await new Promise(r => setTimeout(r, 300));
  }
}
export const config: Config = {
  schedule: "0 11 * * *",  // 7 AM ET = 11 AM UTC
};
