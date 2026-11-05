// Transactional email via Resend (same account as the daily report). No-ops when not configured.
const RESEND = "https://api.resend.com/emails";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export async function sendMail(to: string, subject: string, paragraphs: string[]) {
  if (!process.env.RESEND_API_KEY || !to) { console.log("mail skipped:", subject); return false; }
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#0D1520;max-width:560px">
    <p style="font-weight:800;letter-spacing:.08em">R SHARK</p>${paragraphs.map(p => `<p>${p}</p>`).join("")}
    <p style="color:#6B7A8C;font-size:12px">P National Group LLC · info@p-national.com · <a href="https://rshark.net/terms.html">Terms</a> · <a href="https://rshark.net/terms.html#privacy">Privacy</a></p></div>`;
  const r = await fetch(RESEND, { method: "POST", signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.BILLING_EMAIL_FROM || process.env.REPORT_EMAIL_FROM || "R Shark <reports@rshark.net>",
      reply_to: "info@p-national.com", to: [to], subject, html }) }).catch(e => { console.error("mail failed", e); return null; });
  return !!r?.ok;
}

const money = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 });
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const CANCEL = `To cancel, open <a href="https://rshark.net/">rshark.net</a>, click your account, then <b>Manage billing → Cancel plan</b>. Or just reply to this email. You keep access until the end of the period you've paid for.`;

// Auto-renewal acknowledgment (NY GBL 527-a / Cal. B&P 17602(a)(3)): terms, price, period, how to cancel.
export async function sendSubscriptionConfirmation(email: string, sub: any) {
  const item = sub?.items?.data?.[0], price = item?.price || {};
  const name = price.nickname || sub?.metadata?.rshark_plan || "R Shark";
  const interval = price.recurring?.interval === "year" ? "year" : "month";
  const end = sub?.current_period_end || item?.current_period_end;
  return sendMail(email, `You're subscribed to R Shark ${name.replace(/ (monthly|yearly)$/, "")}`, [
    `Thanks for subscribing. Here are the terms of your plan:`,
    `<b>${esc(name)}</b> — ${money(price.unit_amount || 0)} per ${interval}, plus any applicable tax.`,
    `<b>Your plan renews automatically</b> every ${interval}${end ? `, next on <b>${day(end)}</b>,` : ""} at the same price, charged to the card you used, until you cancel.`,
    CANCEL,
    `Your subscription is governed by the <a href="https://rshark.net/terms.html">R Shark Terms of Service</a>, which include an arbitration agreement you may opt out of within 30 days by replying "opt out".`,
  ]);
}

export async function sendRenewalReminder(email: string, invoice: any) {
  const when = invoice?.next_payment_attempt || invoice?.period_end;
  return sendMail(email, `Your R Shark plan renews${when ? " on " + day(when) : " soon"}`, [
    `This is a reminder that your yearly R Shark subscription will renew automatically${when ? ` on <b>${day(when)}</b>` : ""} for <b>${money(invoice?.amount_due || 0)}</b>, charged to your card on file.`,
    `If you'd like to keep R Shark, you don't need to do anything.`,
    CANCEL,
  ]);
}
