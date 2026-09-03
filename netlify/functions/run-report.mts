import type { Config } from "@netlify/functions";

// Lightweight HTTP trigger — fires the background daily report on demand.
// Called by the ⚡ Run Report button in the R Shark header.
// Returns 202 Accepted immediately; the background function does the real work.
export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Call the background function internally so it runs async with 15 min timeout.
  // We fire and forget — don't await so we return 202 instantly.
  const bgUrl = new URL(req.url);
  bgUrl.pathname = "/.netlify/functions/daily-report-background";

  // Kick off without awaiting
  fetch(bgUrl.toString(), {
    method: "POST",
    headers: { "X-Internal-Trigger": "run-report" },
  }).catch(() => {}); // fire and forget

  return new Response(
    JSON.stringify({ ok: true, message: "Report triggered — check your inbox in ~5 minutes" }),
    { status: 202, headers: { "Content-Type": "application/json" } }
  );
}

export const config: Config = {
  path: "/api/run-report",
};
