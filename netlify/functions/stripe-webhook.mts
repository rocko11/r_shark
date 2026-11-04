import type { Config } from "@netlify/functions";
import { verifyWebhook, saveSubscription, stripe } from "../lib/stripe.ts";
import { billing } from "../lib/access.ts";
import { sendSubscriptionConfirmation, sendRenewalReminder } from "../lib/mail.ts";

// POST /api/stripe-webhook — Stripe tells us about subscriptions; we keep sub:<email> in Blobs current.
export default async (req: Request) => {
  const raw = await req.text();
  let evt: any;
  try { evt = await verifyWebhook(raw, req.headers.get("stripe-signature")); }
  catch (e: any) { return new Response(`Webhook rejected: ${e.message}`, { status: 400 }); }
  const o = evt.data?.object || {};
  // Stripe retries and can deliver twice: emails go out once per event.
  const seen = await billing().get(`event:${evt.id}`, { type: "json" }).catch(() => null);
  try {
    if (evt.type === "checkout.session.completed" && o.mode === "subscription" && o.subscription) {
      const sub = await stripe("GET", `/subscriptions/${o.subscription}`);
      const email = o.metadata?.email || o.client_reference_id || o.customer_details?.email;
      await saveSubscription(sub, email);
      if (!seen) await sendSubscriptionConfirmation(String(email || ""), sub).catch(e => console.error("confirmation mail", e));
    } else if (evt.type === "invoice.upcoming") {
      // Renewal notice before each yearly charge (set the lead time in Stripe → Billing settings).
      const line = o.lines?.data?.[0];
      if (!seen && line?.price?.recurring?.interval === "year" || !seen && line?.plan?.interval === "year")
        await sendRenewalReminder(String(o.customer_email || ""), o).catch(e => console.error("reminder mail", e));
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
