import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { gate } from "../lib/access.ts";

// POST /api/deal-summary  { report: <the report JSON the page already has>, region }
// R Shark AI: a plain-English deal summary written by Claude (via Netlify AI Gateway) from the
// facts in the report. Paid plans only; free-preview users get a blurred placeholder and no model call.
// Results are cached by the facts' hash, so re-opening a property doesn't call the model again.
const MODEL = process.env.AI_SUMMARY_MODEL || "claude-sonnet-5-5";
const DAILY_CAP = Number(process.env.AI_SUMMARY_DAILY_CAP || 150);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Keep only facts: drop geometry, provenance, raw URLs and long tails so the prompt stays small.
const DROP = /^(geometry|geom|coordinates|provenance|links?|urls?|raw|html|svg|polygon|rings|centroid|bbox|_.*)$/i;
function compact(v: any, depth = 0): any {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 240 ? v.slice(0, 240) + "…" : v;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) {
    const items = v.slice(0, 12).map(x => compact(x, depth + 1)).filter(x => x !== undefined);
    if (v.length > 12) items.push(`…and ${v.length - 12} more`);
    return items;
  }
  if (typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.test(k) || /^https?:/.test(String(x))) continue;
      const c = compact(x, depth + 1);
      if (c !== undefined && c !== "" && !(Array.isArray(c) && !c.length)) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return undefined;
}

const SYSTEM = `You are R Shark's deal analyst. Readers are New York real estate investors and developers.
You get one property report as JSON. Write a short, plain-English deal summary using ONLY facts in that JSON.
Rules:
- Never invent numbers, names, dates or facts. If something important is missing or failed to load, say so briefly.
- Be specific: quote the actual figures (zoning district, FAR, lot area, buildable square feet, tax amounts, lien amounts, dates).
- Lead with what matters most for a buyer or developer: seller motivation (trusts, liens, foreclosure filings, arrears), development upside, and deal-killers (violations, landmarks, environmental flags, title problems).
- Plain words, no jargon without explanation, no hype. This is research, not legal, tax or investment advice.
Reply with JSON only, exactly this shape:
{"headline": "one sentence verdict, max 22 words",
 "opportunity": ["2-4 short bullets on upside or seller motivation"],
 "risks": ["1-4 short bullets on risks or deal-killers"],
 "next_steps": ["2-3 short, concrete things to check or do next"]}`;

export default async (req: Request) => {
  // GET: is the AI gateway wired up? (?probe=1 makes one tiny model call, at most once an hour.)
  if (req.method === "GET") {
    const ready = !!(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_KEY);
    if (!ready || new URL(req.url).searchParams.get("probe") !== "1") return json({ ai_ready: ready, model: MODEL });
    const store = getStore({ name: "ai-summaries" });
    const last: any = await store.get("probe", { type: "json" }).catch(() => null);
    if (last && Date.now() - last.at < 3600e3) return json({ ai_ready: ready, model: MODEL, probe: last });
    let probe: any;
    try {
      const m = await new Anthropic().messages.create({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "Reply with the word OK." }] }, { timeout: 20_000 });
      probe = { ok: true, reply: m.content.map((c: any) => c.text || "").join("").slice(0, 20), at: Date.now() };
    } catch (e: any) { probe = { ok: false, error: String(e?.status || "") + " " + String(e?.message || e).slice(0, 160), at: Date.now() }; }
    await store.setJSON("probe", probe).catch(() => {});
    return json({ ai_ready: ready, model: MODEL, probe });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const ent = await gate(req, "basic", { preview: true });
  if (ent instanceof Response) return ent;
  const body: any = await req.json().catch(() => null);
  if (!body?.report || typeof body.report !== "object") return json({ error: "report required" }, 400);

  // Free preview: never call the model — the page shows this blurred with an upgrade prompt.
  if (ent.teaser || body.report.locked) return json({ locked: true, summary: {
    headline: "Strong seller-motivation signals with meaningful unused development rights on this lot.",
    opportunity: ["Recorded filings point to an owner who may sell", "Zoning allows more floor area than is built today"],
    risks: ["Open items on the building record to clear before closing"],
    next_steps: ["Pull the full title and lien history", "Confirm buildable area with your architect"] } });

  if (!process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_API_KEY)
    return json({ error: "R Shark AI isn't switched on for this site yet.", code: "ai_unavailable" }, 503);

  const facts = compact(body.report) || {};
  let text = JSON.stringify(facts);
  if (text.length > 24000) text = text.slice(0, 24000);
  const hash = createHash("sha256").update(MODEL + "|" + text).digest("hex").slice(0, 32);
  const store = getStore({ name: "ai-summaries" });
  const hit: any = await store.get(`s:${hash}`, { type: "json" }).catch(() => null);
  if (hit && Date.now() - hit.at < 7 * 864e5) return json({ summary: hit.summary, model: hit.model, cached: true });

  // Per-person daily cap keeps costs bounded.
  const dayKey = `cap:${ent.email}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await store.get(dayKey).catch(() => null)) || 0);
  if (used >= DAILY_CAP && ent.plan !== "owner") return json({ error: "You've reached today's limit for AI summaries.", code: "limit_reached" }, 429);

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 700, temperature: 0.2, system: SYSTEM,
      messages: [{ role: "user", content: `Region: ${String(body.region || "nyc").slice(0, 8)}\nReport JSON:\n${text}` }],
    }, { timeout: 45_000 });
    const out = msg.content.map((c: any) => c.type === "text" ? c.text : "").join("").trim();
    const m = out.match(/\{[\s\S]*\}/);
    let summary: any = null;
    try { summary = m ? JSON.parse(m[0]) : null; } catch { summary = null; }
    if (!summary?.headline) return json({ error: "The AI summary came back empty. Try again." }, 502);
    const clean = (a: any) => (Array.isArray(a) ? a : []).map((s: any) => String(s).slice(0, 300)).slice(0, 5);
    summary = { headline: String(summary.headline).slice(0, 240), opportunity: clean(summary.opportunity), risks: clean(summary.risks), next_steps: clean(summary.next_steps) };
    await store.setJSON(`s:${hash}`, { summary, model: MODEL, at: Date.now() }).catch(() => {});
    await store.set(dayKey, String(used + 1)).catch(() => {});
    return json({ summary, model: MODEL });
  } catch (e: any) {
    console.error("deal-summary failed", e?.status, e?.message);
    return json({ error: "R Shark AI is busy right now. Try again in a moment." }, 502);
  }
};

export const config: Config = { path: "/api/deal-summary" };
