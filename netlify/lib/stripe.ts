// Minimal Stripe REST client (no SDK): checkout, customer portal, one-click setup, webhook verification.
// Needs only STRIPE_SECRET_KEY in Netlify env. Prices are found by lookup_key, and the webhook
// signing secret is stored in Netlify Blobs by setupStripe(), so nothing else has to be configured.
import { createHmac, timingSafeEqual } from "node:crypto";
import { billing, PLANS } from "./access.ts";

const API = "https://api.stripe.com/v1";
export const stripeKey = () => process.env.STRIPE_SECRET_KEY || "";
export const stripeMode = () => (stripeKey().startsWith("sk_live") || stripeKey().startsWith("rk_live") ? "live" : stripeKey() ? "test" : "missing");

function form(obj: any, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`));
    else if (typeof v === "object") form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}
export async function stripe(method: "GET" | "POST" | "DELETE", path: string, body?: any): Promise<any> {
  const key = stripeKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set in Netlify.");
  const qs = method === "GET" && body ? "?" + form(body).join("&") : "";
  const r = await fetch(`${API}${path}${qs}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body: method === "POST" && body ? form(body).join("&") : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Stripe HTTP ${r.status}`);
  return j;
}

export const lookupKey = (plan: string, interval: "month" | "year") => `rshark_${plan}_${interval === "year" ? "yearly" : "monthly"}`;

export async function priceFor(plan: string, interval: "month" | "year") {
  const r = await stripe("GET", "/prices", { lookup_keys: [lookupKey(plan, interval)], active: "true", limit: 1 });
  return r.data?.[0] || null;
}

// Creates (idempotently) the 3 products × 2 prices, the webhook endpoint and a customer-portal configuration.
export async function setupStripe(origin: string) {
  const log: string[] = [];
  for (const [plan, d] of Object.entries(PLANS)) {
    let product = (await stripe("GET", "/products/search", { query: `metadata['rshark_plan']:'${plan}'` }).catch(() => ({ data: [] }))).data?.[0];
    if (!product) {
      product = await stripe("POST", "/products", { name: `R Shark ${d.name}`, metadata: { rshark_plan: plan },
        description: plan === "starter" ? "25 NYC / NJ / NY State property reports a month, Hunt search, PDF export."
          : plan === "pro" ? "Unlimited property reports, every Hunt list (trusts, liens, pre-foreclosure), CSV export, 50 owner lookups a month."
          : "Everything in Pro for up to 5 users, 250 owner lookups a month." });
      log.push(`created product ${product.name}`);
    }
    for (const interval of ["month", "year"] as const) {
      const lk = lookupKey(plan, interval);
      const existing = await priceFor(plan, interval);
      const amount = (interval === "month" ? d.price_m : d.price_y) * 100;
      if (existing && existing.unit_amount === amount && existing.product === product.id) continue;
      await stripe("POST", "/prices", { product: product.id, currency: "usd", unit_amount: amount, recurring: { interval },
        lookup_key: lk, transfer_lookup_key: "true", nickname: `${d.name} ${interval === "month" ? "monthly" : "yearly"}`, metadata: { rshark_plan: plan } });
      log.push(`price ${lk} = $${amount / 100}/${interval}`);
    }
  }
  // Webhook
  const url = `${origin}/api/stripe-webhook`;
  const events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed", "invoice.paid"];
  const hooks = (await stripe("GET", "/webhook_endpoints", { limit: 100 })).data || [];
  const store = billing();
  const saved: any = await store.get(`stripe:webhook:${stripeMode()}`, { type: "json" }).catch(() => null);
  let hook = hooks.find((h: any) => h.url === url && h.status === "enabled");
  if (!hook || !saved?.secret || saved.id !== hook.id) {
    if (hook) await stripe("DELETE", `/webhook_endpoints/${hook.id}`).catch(() => {});
    hook = await stripe("POST", "/webhook_endpoints", { url, enabled_events: events, description: "R Shark subscriptions", api_version: "2024-06-20" });
    await store.setJSON(`stripe:webhook:${stripeMode()}`, { id: hook.id, secret: hook.secret, url });
    log.push(`webhook → ${url}`);
  }
  // Customer portal (cancel, change plan, update card, invoices)
  const prices: any[] = [];
  for (const [plan] of Object.entries(PLANS)) for (const interval of ["month", "year"] as const) { const p = await priceFor(plan, interval); if (p) prices.push(p); }
  const byProduct: Record<string, string[]> = {};
  prices.forEach(p => (byProduct[p.product] ||= []).push(p.id));
  const cfgs = (await stripe("GET", "/billing_portal/configurations", { limit: 10, is_default: "true" })).data || [];
  const portal = {
    business_profile: { headline: "Manage your R Shark subscription" },
    features: {
      customer_update: { enabled: "true", allowed_updates: ["email", "address"] },
      invoice_history: { enabled: "true" }, payment_method_update: { enabled: "true" },
      subscription_cancel: { enabled: "true", mode: "at_period_end" },
      subscription_update: { enabled: "true", default_allowed_updates: ["price"], proration_behavior: "create_prorations",
        products: Object.entries(byProduct).map(([product, ids]) => ({ product, prices: ids })) },
    },
  };
  if (cfgs[0]) await stripe("POST", `/billing_portal/configurations/${cfgs[0].id}`, portal);
  else await stripe("POST", "/billing_portal/configurations", portal);
  log.push("customer portal configured");
  return { mode: stripeMode(), log };
}

export async function verifyWebhook(raw: string, sigHeader: string | null): Promise<any> {
  const saved: any = await billing().get(`stripe:webhook:${stripeMode()}`, { type: "json" }).catch(() => null);
  const secret = process.env.STRIPE_WEBHOOK_SECRET || saved?.secret;
  if (!secret) throw new Error("No webhook secret — run Set up Stripe first.");
  const parts = Object.fromEntries(String(sigHeader || "").split(",").map(s => s.split("=") as [string, string]));
  const t = parts.t; const sigs = String(sigHeader || "").split(",").filter(s => s.startsWith("v1=")).map(s => s.slice(3));
  if (!t || !sigs.length) throw new Error("Missing Stripe signature.");
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) throw new Error("Stale webhook timestamp.");
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  const ok = sigs.some(s => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error("Bad Stripe signature.");
  return JSON.parse(raw);
}

// Store the subscription under the subscriber's email.
export async function saveSubscription(sub: any, emailHint?: string) {
  const store = billing();
  let email = String(sub.metadata?.email || emailHint || "").toLowerCase();
  if (!email && sub.customer) {
    const c = await stripe("GET", `/customers/${sub.customer}`).catch(() => null);
    email = String(c?.email || "").toLowerCase();
  }
  if (!email) return null;
  const item = sub.items?.data?.[0];
  const price = item?.price || {};
  const plan = price.metadata?.rshark_plan || String(price.lookup_key || "").split("_")[1] || null;
  const prev: any = await store.get(`sub:${email}`, { type: "json" }).catch(() => null);
  const rec = {
    email, plan, interval: price.recurring?.interval || null, status: sub.status, customer: sub.customer, subscription: sub.id,
    current_period_end: (item?.current_period_end || sub.current_period_end) ? new Date((item?.current_period_end || sub.current_period_end) * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end, members: prev?.members || [], updated_at: new Date().toISOString(),
  };
  await store.setJSON(`sub:${email}`, rec);
  await store.setJSON(`customer:${sub.customer}`, { email });
  return rec;
}
