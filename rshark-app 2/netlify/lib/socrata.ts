// Async Socrata client. Live-proxy: no local mirror. Runs inside a Netlify
// Function, so it must stay well under the function timeout (10s default).

import { BASE, DATASETS, type Dataset } from "./datasets.ts";

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";
// Without a token you share a throttled anonymous pool and hit 429s under load.
// Set it in Netlify: Site settings -> Environment variables.

const TIMEOUT_MS = 8000;

export class SocrataError extends Error {}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (APP_TOKEN) h["X-App-Token"] = APP_TOKEN;
  return h;
}

function quote(v: unknown): string {
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function buildWhere(clauses: Record<string, unknown>): string {
  return Object.entries(clauses).map(([k, v]) => `${k}=${quote(v)}`).join(" AND ");
}

export function buildIn(field: string, values: string[]): string {
  return `${field} in(${values.map(quote).join(", ")})`;
}

interface QueryOpts {
  where?: string; select?: string; order?: string; limit?: number; retries?: number;
}

export async function query(
  dataset: string | Dataset, opts: QueryOpts = {},
): Promise<any[]> {
  const ds = typeof dataset === "string" ? DATASETS[dataset] : dataset;
  const { where, select, order, limit = 1000, retries = 2 } = opts;

  const params = new URLSearchParams();
  params.set("$limit", String(limit));
  if (where) params.set("$where", where);
  if (select) params.set("$select", select);
  if (order || ds.orderBy) params.set("$order", order || ds.orderBy!);

  const url = `${BASE}/${ds.socrataId}.json?${params.toString()}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const r = await fetch(url, { headers: headers(), signal: ctrl.signal });
      clearTimeout(timer);

      if (r.status === 400) {
        // Almost always schema drift: a field in select/where/order is gone.
        const body = await r.text();
        throw new SocrataError(
          `${ds.slug} (${ds.socrataId}) 400 — likely field drift. ${body.slice(0, 200)}`);
      }
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e instanceof SocrataError) throw e;
      lastErr = e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  throw new SocrataError(`${ds.slug} failed: ${lastErr}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run named tasks concurrently; a single failure degrades that section of the
// report rather than killing the whole request.
export async function gather(
  tasks: Record<string, Promise<any>>,
): Promise<{ data: Record<string, any>; errors: Record<string, string> }> {
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(names.map((n) => tasks[n]));
  const data: Record<string, any> = {};
  const errors: Record<string, string> = {};
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") data[names[i]] = res.value;
    else errors[names[i]] = String(res.reason).slice(0, 200);
  });
  return { data, errors };
}
