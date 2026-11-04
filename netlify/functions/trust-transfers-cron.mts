import type { Config } from "@netlify/functions";

// Daily trigger for the trust-transfer list. Scheduled functions are limited to 30 s, so this just
// starts the background builder (up to 15 min) and returns.
export default async () => {
  const base = process.env.URL || "https://rshark.net";
  const r = await fetch(`${base}/.netlify/functions/trust-build-background`, { method: "POST" }).catch((e) => ({ status: String(e) }));
  console.log("trust-build-background kicked:", (r as any).status);
};

export const config: Config = { schedule: "20 9 * * *" };
