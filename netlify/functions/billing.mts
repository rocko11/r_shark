import type { Config } from "@netlify/functions";
import { getUser, entitlement, billing, PLANS, OWNER_EMAILS, listGrants, saveGrant, deleteGrant, getUsage } from "../lib/access.ts";
import { stripe, priceFor, setupStripe, stripeMode } from "../lib/stripe.ts";
import { recordConsent, TERMS_VERSION } from "../lib/consent.ts";

// POST /api/billing  { action: "checkout", plan, interval } | { action: "portal" } | { action: "setup" }
//                    | { action: "team-add" | "team-remove", email }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const user = await getUser(req);
  if (!user) return json({ error: "Sign in first.", code: "auth_required" }, 401);
  const body: any = await req.json().catch(() => ({}));
  const origin = new URL(req.url).origin;
  const store = billing();
  try {
    if (body.action === "setup") {
      if (!OWNER_EMAILS.has(user.email)) return json({ error: "Only the site owner can set up Stripe." }, 403);
      return json(await setupStripe(origin));
    }
    // Owner: give chosen people free monthly usage (no Stripe).
    if (body.action === "grant-list" || body.action === "grant-add" || body.action === "grant-remove") {
      if (!OWNER_EMAILS.has(user.email)) return json({ error: "Only the site owner can manage free access." }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      if (body.action !== "grant-list" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
      if (body.action === "grant-add") {
        const plan = String(body.plan || "pro");
        if (plan !== "starter" && plan !== "pro") return json({ error: "Free access can be Starter or Pro." }, 400);
        const reports = body.reports === "" || body.reports == null ? undefined : body.reports === "unlimited" ? null : Math.max(0, Math.min(10000, Math.round(Number(body.reports))));
        if (reports !== undefined && reports !== null && !Number.isFinite(reports)) return json({ error: "Reports per month must be a number or unlimited." }, 400);
        const months = Number(body.months || 0);
        const expires = months > 0 ? new Date(Date.now() + months * 30.44 * 864e5).toISOString() : null;
        const skip = body.skiptrace === "" || body.skiptrace == null ? undefined : Math.max(0, Math.min(5000, Math.round(Number(body.skiptrace))));
        await saveGrant({ email, plan: plan as any, ...(reports !== undefined ? { reports } : {}), ...(skip !== undefined ? { skiptrace: skip } : {}),
          expires, note: String(body.note || "").slice(0, 120), by: user.email, at: new Date().toISOString() });
      }
      if (body.action === "grant-remove") await deleteGrant(email);
      const grants = await listGrants();
      const withUse = await Promise.all(grants.map(async g => ({ ...g, usage: await getUsage(g.email).then(u => ({ reports: u.reports, skiptrace: u.skiptrace })).catch(() => null) })));
      return json({ grants: withUse });
    }
    if (body.action === "ack-outreach") {
      if (body.agree !== TERMS_VERSION) return json({ error: "Consent required." }, 400);
      await recordConsent(req, user.email, "outreach", { text: "FCRA permissible-use and TCPA/DNC outreach acknowledgment" });
      return json({ ok: true });
    }
    if (body.action === "checkout") {
      const plan = String(body.plan || ""), interval = body.interval === "year" ? "year" : "month";
      if (!(plan in PLANS)) return json({ error: "Unknown plan." }, 400);
      const price = await priceFor(plan, interval);
      if (!price) return json({ error: "Plans aren't set up in Stripe yet." , code: "stripe_not_setup" }, 503);
      // Affirmative consent to the Terms and to automatic renewal is required before any charge
      // (NY GBL 527-a, Cal. Bus. & Prof. 17602) — the checkbox next to the plan buttons sends it.
      if (body.agree !== TERMS_VERSION) return json({ error: "Please tick the box to agree to the Terms and automatic renewal.", code: "consent_required", terms_version: TERMS_VERSION }, 400);
      const amount = interval === "year" ? PLANS[plan as keyof typeof PLANS].price_y : PLANS[plan as keyof typeof PLANS].price_m;
      await recordConsent(req, user.email, "checkout", { plan, interval, amount, price: price.id, disclosure: body.disclosure ? String(body.disclosure).slice(0, 400) : undefined });
      const sub: any = await store.get(`sub:${user.email}`, { type: "json" }).catch(() => null);
      const trial = Number(process.env.STRIPE_TRIAL_DAYS || 0);
      const session = await stripe("POST", "/checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: price.id, quantity: 1 }],
        ...(sub?.customer ? { customer: sub.customer } : { customer_email: user.email }),
        client_reference_id: user.email,
        subscription_data: { metadata: { email: user.email, rshark_plan: plan, terms_version: TERMS_VERSION }, ...(trial > 0 && !sub ? { trial_period_days: trial } : {}) },
        metadata: { email: user.email, rshark_plan: plan, terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() },
        // Repeat the renewal terms right above Stripe's Subscribe button.
        custom_text: { submit: { message: `Your R Shark ${PLANS[plan as keyof typeof PLANS].name} plan renews automatically every ${interval} at $${amount.toLocaleString()} plus any tax until you cancel. Cancel anytime from your R Shark account page; access continues to the end of the paid period. By subscribing you agree to the R Shark Terms of Service (rshark.net/terms.html), including the arbitration clause.` } },
        allow_promotion_codes: "true",
        billing_address_collection: "auto",
        ...(process.env.STRIPE_AUTOMATIC_TAX === "1" ? { automatic_tax: { enabled: "true" } } : {}),
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancelled`,
      });
      return json({ url: session.url });
    }
    if (body.action === "portal") {
      const ent = await entitlement(user.email);
      const sub: any = await store.get(`sub:${ent.account}`, { type: "json" }).catch(() => null);
      if (!sub?.customer || ent.member_of) return json({ error: ent.member_of ? "Your team owner manages billing." : "No subscription yet." }, 400);
      const s = await stripe("POST", "/billing_portal/sessions", { customer: sub.customer, return_url: `${origin}/?billing=portal` });
      return json({ url: s.url });
    }
    if (body.action === "team-add" || body.action === "team-remove") {
      const ent = await entitlement(user.email);
      if (ent.plan !== "team" || ent.member_of) return json({ error: "Only the Team plan owner can manage seats." }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
      const sub: any = await store.get(`sub:${user.email}`, { type: "json" });
      const members = new Set<string>(sub.members || []);
      if (body.action === "team-add") {
        if (members.size >= PLANS.team.seats - 1 && !members.has(email)) return json({ error: `The Team plan includes ${PLANS.team.seats} users (you + ${PLANS.team.seats - 1}).` }, 400);
        members.add(email); await store.setJSON(`member:${email}`, { owner: user.email });
      } else { members.delete(email); await store.delete(`member:${email}`).catch(() => {}); }
      sub.members = [...members]; await store.setJSON(`sub:${user.email}`, sub);
      return json({ members: sub.members });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e), stripe: stripeMode() }, 502);
  }
};
export const config: Config = { path: "/api/billing" };
