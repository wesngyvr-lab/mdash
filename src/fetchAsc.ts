import 'dotenv/config';
import './http.js';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { WINDOWS, WINDOW_DAYS, emptyWindows, type AppMetrics, type Window } from './types.js';

const ASC_API = 'https://api.appstoreconnect.apple.com/v1';

function loadEnv() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;
  const vendorNumber = process.env.ASC_VENDOR_NUMBER;
  const appId = process.env.ASC_APP_ID;
  if (!keyId || !issuerId || !keyPath) {
    throw new Error('Missing ASC_KEY_ID, ASC_ISSUER_ID, or ASC_KEY_PATH');
  }
  if (!appId) {
    throw new Error('Missing ASC_APP_ID (your App Store ID — find it in App Store Connect → My Apps → App Information)');
  }
  return { keyId, issuerId, keyPath, vendorNumber, appId };
}

function signJwt(keyId: string, issuerId: string, keyPath: string): string {
  const privateKey = readFileSync(keyPath, 'utf8');
  return jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '20m',
    issuer: issuerId,
    audience: 'appstoreconnect-v1',
    keyid: keyId,
    header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
  });
}

function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

type SalesRow = {
  productTypeId: string;
  units: number;
  developerProceeds: number;
  currencyOfProceeds: string;
  beginDate: string;
  appleIdentifier: string;
};

function parseTsv(tsv: string): SalesRow[] {
  const lines = tsv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  const idx = (name: string) => headers.indexOf(name);
  const i = {
    productTypeId: idx('Product Type Identifier'),
    units: idx('Units'),
    proceeds: idx('Developer Proceeds'),
    currency: idx('Currency of Proceeds'),
    beginDate: idx('Begin Date'),
    appleId: idx('Apple Identifier'),
  };
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    return {
      productTypeId: cols[i.productTypeId] ?? '',
      units: Number(cols[i.units] ?? 0),
      developerProceeds: Number(cols[i.proceeds] ?? 0),
      currencyOfProceeds: cols[i.currency] ?? '',
      beginDate: cols[i.beginDate] ?? '',
      appleIdentifier: cols[i.appleId] ?? '',
    };
  });
}

// Product type IDs that represent NEW downloads (not updates, not IAPs)
// "1" = paid app, "1F" = free app, "1T" = universal, "1TP" = universal paid, "1E"/"1EP" = etc.
// Anything starting with "7" is updates; "I" = in-app purchases
function isDownload(productTypeId: string): boolean {
  return productTypeId.startsWith('1') && !productTypeId.startsWith('I');
}

async function fetchOneDay(
  date: string,
  vendorNumber: string,
  token: string,
  appId: string
): Promise<SalesRow[]> {
  const params = new URLSearchParams({
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[frequency]': 'DAILY',
    'filter[reportDate]': date,
    'filter[vendorNumber]': vendorNumber,
    'filter[version]': '1_0',
  });
  const res = await fetch(`${ASC_API}/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' },
  });
  if (res.status === 404) return []; // No report for this date yet
  if (!res.ok) {
    throw new Error(`ASC ${date}: ${res.status} ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tsv = gunzipSync(buf).toString('utf8');
  return parseTsv(tsv).filter((r) => r.appleIdentifier === appId);
}

// Run promises with limited concurrency
async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchAsc(): Promise<AppMetrics> {
  const env = loadEnv();
  const appName = process.env.APP_NAME ?? 'App';
  const result: AppMetrics = {
    source: 'app_store',
    appName,
    windows: emptyWindows({ downloads: 0, revenueUsd: 0 }),
    rating: null,
  };

  if (!env.vendorNumber) {
    result.error =
      'ASC_VENDOR_NUMBER not set. Find at appstoreconnect.apple.com → Payments and Financial Reports';
    return result;
  }

  const token = signJwt(env.keyId, env.issuerId, env.keyPath);

  // Build list of last 365 dates (skip today, often unavailable)
  const dates: string[] = [];
  for (let i = 1; i <= 365; i++) {
    dates.push(dateString(daysAgo(i)));
  }

  console.log(`[ASC] Fetching ${dates.length} daily reports (concurrency 5)...`);
  const allRows = await runConcurrent(dates, 5, async (date) => {
    try {
      const rows = await fetchOneDay(date, env.vendorNumber!, token, env.appId);
      return { date, rows };
    } catch (err) {
      console.warn(`[ASC] ${date}: ${(err as Error).message}`);
      return { date, rows: [] as SalesRow[] };
    }
  });

  // Aggregate per window
  const today = new Date();
  for (const w of WINDOWS) {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - WINDOW_DAYS[w]);
    const cutoffStr = dateString(cutoff);

    let downloads = 0;
    let revenueUsd = 0;
    for (const { date, rows } of allRows) {
      if (date < cutoffStr) continue;
      for (const r of rows) {
        if (isDownload(r.productTypeId)) downloads += r.units;
        // Only count USD-denominated proceeds; mark in output
        if (r.currencyOfProceeds === 'USD') {
          revenueUsd += r.developerProceeds * r.units;
        }
      }
    }
    result.windows[w] = { downloads, revenueUsd };
  }

  return result;
}

// Run as standalone for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAsc()
    .then((data) => console.log(JSON.stringify(data, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
