import type { Config } from "@netlify/functions";
import { getUser, entitlement, getUsage, PLANS, OWNER_EMAILS } from "../lib/access.ts";
import { stripeMode } from "../lib/stripe.ts";

// GET /api/me — who am I, what plan, how much have I used, what can I buy.
export default async (req: Request) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const user = await getUser(req);
  const plans = Object.fromEntries(Object.entries(PLANS).map(([k, d]) => [k, { name: d.name, price_m: d.price_m, price_y: d.price_y, reports: d.reports, skiptrace: d.skiptrace, seats: d.seats, features: d.features }]));
  if (!user) return json({ signed_in: false, plans, stripe: stripeMode() });
  const ent = await entitlement(user.email);
  const usage = await getUsage(ent.account);
  return json({
    signed_in: true, email: user.email, is_owner: OWNER_EMAILS.has(user.email),
    active: ent.active, plan: ent.plan, plan_name: ent.def?.name || null, status: ent.status,
    limits: ent.def ? { reports: ent.def.reports, skiptrace: ent.def.skiptrace, seats: ent.def.seats, features: ent.def.features } : null,
    usage: { month: usage.month, reports: usage.reports, skiptrace: usage.skiptrace },
    renews: ent.sub?.current_period_end || null, cancel_at_period_end: !!ent.sub?.cancel_at_period_end,
    interval: ent.sub?.interval || null, member_of: ent.member_of || null,
    members: ent.plan === "team" && !ent.member_of ? (ent.sub?.members || []) : undefined,
    plans, stripe: stripeMode(),
  });
};
export const config: Config = { path: "/api/me" };
