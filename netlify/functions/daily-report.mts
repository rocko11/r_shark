import type { Config } from "@netlify/functions";

// ── Daily R Shark deal-scout ────────────────────────────────────────────────
// Runs every morning at 7 AM UTC (3 AM ET). Queries all three distress
// signals across your target ZIPs, scores each property 0-100, then emails
// a ranked HTML digest via Resend (free tier = 3k emails/month).
//
// Required env vars (set in Netlify → Site configuration → Environment variables):
//   RESEND_API_KEY   - from resend.com (free, takes 2 minutes to set up)
//   REPORT_EMAIL_TO  - where to send the report (e.g. roeipaz@gmail.com)
//   REPORT_EMAIL_FROM - verified sender address in Resend (e.g. reports@rshark.net)
//   REPORT_ZIPS      - comma-separated ZIPs to scan (e.g. 11238,10036,11201)
//   SOCRATA_APP_TOKEN - already set

const PLUTO = "https://data.cityofnewyork.us/resource/64uk-42ks.json";
const LIEN  = "https://data.cityofnewyork.us/resource/9rz4-mjek.json";
const HPD   = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";
const ECB   = "https://data.cityofnewyork.us/resource/6bgk-3dad.json";
const RESEND = "https://api.resend.com/emails";

const TOKEN = process.env.SOCRATA_APP_TOKEN;
const ZIPS  = (process.env.REPORT_ZIPS || "11238").split(",").map(z => z.trim()).filter(Boolean);

const esc = (s: string) => String(s ?? "").replace(/'/g, "''");

// Fetch helper with app token
async function soql(url: string, params: Record<string, string>): Promise<any[]> {
  const p = new URLSearchParams(params);
  if (TOKEN) p.set("$$app_token", TOKEN);
  try {
    const r = await fetch(`${url}?${p}`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Build BBL from boro+block+lot (lien/HPD/ECB use raw numbers)
const BORO: Record<string, string> = { MANHATTAN:"1", BRONX:"2", BROOKLYN:"3", QUEENS:"4", "STATEN ISLAND":"5" };
function mkBBL(b: string, blk: string, lt: string) {
  const bd = String(b).replace(/\D/g,""), bk = String(blk).replace(/\D/g,"").padStart(5,"0"), l = String(lt).replace(/\D/g,"").padStart(4,"0");
  return (bd && bk !== "00000" && l !== "0000") ? bd+bk+l : null;
}

type Score = {
  bbl: string; address: string; zip: string;
  lien: boolean; lien_type: string;
  hpd_c: number; ecb_balance: number;
  lot_area: number | null; bldg_class: string | null; year_built: string | null;
  score: number; signals: string[];
};

export default async function handler() {
  if (!process.env.RESEND_API_KEY) { console.log("RESEND_API_KEY not set — skipping email"); return; }
  if (!process.env.REPORT_EMAIL_TO) { console.log("REPORT_EMAIL_TO not set"); return; }

  console.log(`R Shark daily report — scanning ZIPs: ${ZIPS.join(", ")}`);

  // ── 1. Fetch all three distress signals in parallel per ZIP ────────────────
  const zipFilter = (field: string) => ZIPS.map(z => `${field}='${esc(z)}'`).join(" OR ");

  const [lienRows, hpdRows, ecbRows] = await Promise.all([
    soql(LIEN, { $select:"borough,block,lot,house_number,street_name,zip_code,water_debt_only,cycle,building_class", $where: ZIPS.map(z=>`zip_code='${esc(z)}'`).join(" OR "), $limit:"5000" }),
    soql(HPD,  { $select:"boroid,block,lot,boro,novdescription,novissueddate", $where:`class='C' AND currentstatusid=2 AND (${ZIPS.map(z=>`zip='${esc(z)}'`).join(" OR ")})`, $limit:"5000" }),
    soql(ECB,  { $select:"boro,block,lot,balance_due,ecb_violation_status,violation_type,respondent_zip", $where:`ecb_violation_status='ACTIVE' AND balance_due>0 AND (${ZIPS.map(z=>`respondent_zip='${esc(z)}'`).join(" OR ")})`, $limit:"5000" }),
  ]);

  // ── 2. Aggregate signals per BBL ───────────────────────────────────────────
  const props = new Map<string, Score>();

  const ensure = (bbl: string, addr: string, zip: string): Score => {
    if (!props.has(bbl)) props.set(bbl, { bbl, address: addr, zip, lien: false, lien_type: "", hpd_c: 0, ecb_balance: 0, lot_area: null, bldg_class: null, year_built: null, score: 0, signals: [] });
    return props.get(bbl)!;
  };

  for (const r of lienRows) {
    const bbl = mkBBL(String(r.borough), r.block, r.lot); if (!bbl) continue;
    const addr = [r.house_number, r.street_name].filter(Boolean).join(" ");
    const p = ensure(bbl, addr, r.zip_code || "");
    p.lien = true;
    p.lien_type = (String(r.water_debt_only||"").toUpperCase()==="YES") ? "Water/sewer lien" : "Tax lien";
  }
  for (const r of hpdRows) {
    const bd = BORO[String(r.boro||"").toUpperCase().trim()] || String(r.boroid||"").replace(/\D/g,"");
    const bbl = mkBBL(bd, r.block, r.lot); if (!bbl) continue;
    const p = ensure(bbl, bbl, "");
    p.hpd_c++;
  }
  for (const r of ecbRows) {
    const bbl = mkBBL(String(r.boro||""), r.block, r.lot); if (!bbl) continue;
    const p = ensure(bbl, bbl, r.respondent_zip||"");
    p.ecb_balance += Math.round(Number(r.balance_due)||0);
  }

  if (!props.size) { console.log("No distressed properties found"); return; }

  // ── 3. Enrich with PLUTO (lot area, class, year) ──────────────────────────
  const bblList = [...props.keys()].slice(0, 500);
  const CHUNK = 100;
  for (let i = 0; i < bblList.length; i += CHUNK) {
    const chunk = bblList.slice(i, i+CHUNK);
    const rows = await soql(PLUTO, { $select:"bbl,address,lotarea,bldgclass,yearbuilt", $where:`bbl in(${chunk.map(Number).join(",")})`, $limit:"500" });
    for (const r of rows) {
      const bbl = String(r.bbl||"").split(".")[0].padStart(10,"0");
      const p = props.get(bbl); if (!p) continue;
      if (r.address) p.address = r.address;
      p.lot_area   = r.lotarea  ? Math.round(Number(r.lotarea))  : null;
      p.bldg_class = r.bldgclass || null;
      p.year_built = r.yearbuilt || null;
    }
  }

  // ── 4. Score each property ─────────────────────────────────────────────────
  // Scoring model (max 100):
  //   Lien present           +25 pts
  //   Water lien (harder)    +10 pts bonus
  //   HPD Class C violations +5 pts each (max 25)
  //   ECB balance            +1 pt per $1k (max 20)
  //   Vacant lot class       +15 pts
  //   Large lot (>5000 sf)   +5 pts
  for (const p of props.values()) {
    let s = 0; const sig: string[] = [];
    if (p.lien)       { s += 25; sig.push(p.lien_type); }
    if (p.lien_type==="Water/sewer lien") { s += 10; }
    if (p.hpd_c > 0)  { const pts = Math.min(p.hpd_c * 5, 25); s += pts; sig.push(`${p.hpd_c} HPD Class C violation${p.hpd_c>1?"s":""}`); }
    if (p.ecb_balance > 0) { const pts = Math.min(Math.floor(p.ecb_balance/1000), 20); s += pts; sig.push(`$${p.ecb_balance.toLocaleString()} ECB fines`); }
    if (p.bldg_class?.startsWith("V")) { s += 15; sig.push("Vacant lot"); }
    if ((p.lot_area||0) > 5000) { s += 5; sig.push(`${p.lot_area!.toLocaleString()} sf`); }
    p.score = Math.min(s, 100);
    p.signals = sig;
  }

  // ── 5. Rank and take top 20 ────────────────────────────────────────────────
  const top = [...props.values()].sort((a,b) => b.score - a.score).slice(0, 20);

  // ── 6. Build HTML email ────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  const scoreColor = (s: number) => s >= 70 ? "#FF4B3E" : s >= 45 ? "#FFB03A" : "#2FE0C6";
  const rows = top.map((p, i) => `
    <tr style="border-bottom:1px solid #1C2532">
      <td style="padding:10px 8px;font-size:13px;color:#8A97A8;text-align:center">${i+1}</td>
      <td style="padding:10px 8px">
        <a href="https://rshark.net/?bbl=${p.bbl}" style="color:#EAF0F6;font-weight:700;text-decoration:none;font-size:14px">${p.address || p.bbl}</a>
        <div style="color:#8A97A8;font-size:12px;margin-top:3px">${p.signals.join(" · ")||"—"}</div>
        <div style="color:#8A97A8;font-size:11px;margin-top:2px">BBL: ${p.bbl}${p.bldg_class ? " · " + p.bldg_class : ""}${p.year_built ? " · Built " + p.year_built : ""}${p.zip ? " · " + p.zip : ""}</div>
      </td>
      <td style="padding:10px 8px;text-align:right;white-space:nowrap">
        <span style="background:${scoreColor(p.score)};color:#0A0E14;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">${p.score}</span>
      </td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0A0E14;font-family:system-ui,sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <svg width="44" height="34" viewBox="0 0 110 84"><path d="M72 52 C 56 50,44 42,41 14 C 30 30,22 42,16 52 C 30 52,52 52,72 52Z" fill="#2FE0C6"/><path d="M 14 6 C 12 20,13 38,12 62" fill="none" stroke="white" stroke-width="8.5" stroke-linecap="round"/><path d="M 14 6 C 26 1,58 4,68 20 C 78 36,66 52,14 52" fill="none" stroke="white" stroke-width="8.5" stroke-linecap="round"/><path d="M 36 52 C 58 56,80 60,98 64" fill="none" stroke="white" stroke-width="7.5" stroke-linecap="round"/><path d="M 98 64 C 103 60,104 54,100 50" fill="none" stroke="white" stroke-width="5.5" stroke-linecap="round"/></svg>
      <span style="color:#EAF0F6;font-size:28px;font-weight:700;letter-spacing:-0.02em">R SHARK</span>
    </div>
    <p style="color:#8A97A8;margin:0 0 28px;font-size:14px">Daily deal scout · ${today}</p>
    <div style="background:#141B26;border-radius:12px;padding:20px 24px;margin-bottom:24px">
      <p style="color:#EAF0F6;margin:0 0 4px;font-size:15px"><strong>ZIPs scanned:</strong> ${ZIPS.join(", ")}</p>
      <p style="color:#8A97A8;margin:0;font-size:13px">${props.size.toLocaleString()} distressed properties found · showing top 20 by deal-potential score</p>
    </div>
    <div style="background:#141B26;border-radius:12px;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid #1C2532">
        <span style="color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em">Score key: </span>
        <span style="background:#FF4B3E;color:#0A0E14;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700">70+ HOT</span>&nbsp;
        <span style="background:#FFB03A;color:#0A0E14;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700">45+ WATCH</span>&nbsp;
        <span style="background:#2FE0C6;color:#0A0E14;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700">&lt;45 TRACK</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="border-bottom:1px solid #28323F">
          <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:center">#</th>
          <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:left">Property</th>
          <th style="padding:10px 8px;color:#8A97A8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;text-align:right">Score</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p style="color:#28323F;font-size:12px;margin-top:24px;text-align:center">R Shark · Informational only. Verify all data before acting.</p>
  </div></body></html>`;

  // ── 7. Send via Resend ─────────────────────────────────────────────────────
  const res = await fetch(RESEND, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.REPORT_EMAIL_FROM || "R Shark <reports@rshark.net>",
      to:   [process.env.REPORT_EMAIL_TO!],
      subject: `🦈 R Shark Daily — Top ${top.length} deals (${ZIPS.join(", ")}) · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`,
      html,
    }),
  });
  const result = await res.json();
  console.log("Email sent:", result.id || result);
}

export const config: Config = {
  schedule: "0 11 * * *",  // 7 AM ET = 11 AM UTC
};
