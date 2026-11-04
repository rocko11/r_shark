import type { Config } from "@netlify/functions";
import { verifyWebhook, saveSubscription, stripe } from "../lib/stripe.ts";
import { billing } from "../lib/access.ts";

// POST /api/stripe-webhook — Stripe tells us about subscriptions; we keep sub:<email> in Blobs current.
export default async (req: Request) => {
  const raw = await req.text();
  let evt: any;
  try { evt = await verifyWebhook(raw, req.headers.get("stripe-signature")); }
  catch (e: any) { return new Response(`Webhook rejected: ${e.message}`, { status: 400 }); }
  const o = evt.data?.object || {};
  try {
    if (evt.type === "checkout.session.completed" && o.mode === "subscription" && o.subscription) {
      const sub = await stripe("GET", `/subscriptions/${o.subscription}`);
      await saveSubscription(sub, o.metadata?.email || o.client_reference_id || o.customer_details?.email);
    } else if (evt.type.startsWith("customer.subscription.")) {
      await saveSubscription(o);
    } else if (evt.type === "invoice.payment_failed" || evt.type === "invoice.paid") {
      if (o.subscription) await saveSubscription(await stripe("GET", `/subscriptions/${o.subscription}`));
    }
    await billing().setJSON(`event:${evt.id}`, { type: evt.type, at: new Date().toISOString() }).catch(() => {});
  } catch (e: any) {
    console.error("webhook handling failed", evt.type, e);
    return new Response("handler error", { status: 500 }); // Stripe will retry
  }
  return new Response("ok", { status: 200 });
};
export const config: Config = { path: "/api/stripe-webhook" };
