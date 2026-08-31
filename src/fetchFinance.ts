// App Store revenue, from the FINANCIAL report.
//
// Why this exists separately from fetchAsc: the daily SALES/SUMMARY report
// fetchAsc reads returns Developer Proceeds of 0 for every row, in every
// currency — verified across all 365 days and 22 currencies. Subscription
// proceeds simply are not in that report, so the dashboard showed $0.00
// revenue while real money was coming in.
//
// The FINANCIAL report has it. Same credentials, different endpoint.
//
// Two things to know about this report:
//   - It is MONTHLY by Apple fiscal period, not daily, so it cannot be sliced
//     into the 7d/30d/90d windows the rest of the dashboard uses. Revenue is
//     reported per fiscal month instead. Apple fiscal months do not line up
//     with calendar months; the row dates show the real span.
//   - A month with no sales returns HTTP 404 with "There were no sales for
//     the date specified." That is a zero, not a failure.
//
// Proceeds stay in their original currency and are never converted — an
// invented FX rate in a revenue number is worse than an honest split.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';

const ASC_API = 'https://api.appstoreconnect.apple.com/v1';

/** How many fiscal months back to ask for. */
const MONTHS_BACK = 13;

export type FinanceMonth = {
  /** The reportDate asked for, `YYYY-MM`. */
  month: string;
  /** Proceeds keyed by currency, e.g. { USD: 4.24 }. Empty when no sales. */
  proceedsByCurrency: Record<string, number>;
  /** Units sold (not free downloads — this report only carries paid rows). */
  units: number;
};

export type FinanceMetrics = {
  months: FinanceMonth[];
  /** Sum across every month fetched, per currency. */
  lifetimeByCurrency: Record<string, number>;
  error?: string;
};

function loadEnv() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_PATH;
  const vendorNumber = process.env.ASC_VENDOR_NUMBER;
  if (!keyId || !issuerId || !keyPath || !vendorNumber) {
    throw new Error(
      'Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH / ASC_VENDOR_NUMBER'
    );
  }
  return { keyId, issuerId, keyPath, vendorNumber };
}

function signJwt(keyId: string, issuerId: string, keyPath: string): string {
  const key = fs.readFileSync(path.resolve(process.cwd(), keyPath), 'utf8');
  return jwt.sign({}, key, {
    algorithm: 'ES256',
    expiresIn: '20m',
    issuer: issuerId,
    audience: 'appstoreconnect-v1',
    header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
  });
}

/** Last MONTHS_BACK report dates as `YYYY-MM`, newest first. */
function recentMonths(now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function fetchOneMonth(
  month: string,
  vendorNumber: string,
  token: string
): Promise<FinanceMonth> {
  const empty: FinanceMonth = { month, proceedsByCurrency: {}, units: 0 };

  const params = new URLSearchParams({
    // ZZ is Apple's consolidated all-regions report.
    'filter[regionCode]': 'ZZ',
    'filter[reportType]': 'FINANCIAL',
    'filter[reportDate]': month,
    'filter[vendorNumber]': vendorNumber,
  });

  const res = await fetch(`${ASC_API}/financeReports?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/a-gzip' },
  });

  // "No sales for the date specified" — a real zero, not an error.
  if (res.status === 404) return empty;
  if (!res.ok) {
    throw new Error(`financeReports ${month}: HTTP ${res.status}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  let text: string;
  try {
    text = zlib.gunzipSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8');
  }

  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return empty;

  const header = lines[0].split('\t');
  const iShare = header.findIndex((h) => /Extended Partner Share/i.test(h));
  const iCur = header.findIndex((h) => /Partner Share Currency/i.test(h));
  const iQty = header.findIndex((h) => /^Quantity$/i.test(h.trim()));
  if (iShare < 0 || iCur < 0) return empty;

  const proceedsByCurrency: Record<string, number> = {};
  let units = 0;

  for (const line of lines.slice(1)) {
    // The file ends with a "Total_Rows<TAB>N" trailer — not a data row.
    if (line.startsWith('Total_Rows')) continue;
    const cols = line.split('\t');
    const share = Number(cols[iShare]);
    if (!Number.isFinite(share) || share === 0) continue;
    const cur = (cols[iCur] ?? '').trim() || 'UNKNOWN';
    proceedsByCurrency[cur] = round2((proceedsByCurrency[cur] ?? 0) + share);
    if (iQty >= 0) {
      const q = Number(cols[iQty]);
      if (Number.isFinite(q)) units += q;
    }
  }

  return { month, proceedsByCurrency, units };
}

/** Float noise compounds fast on money. Keep it to cents. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function fetchFinance(): Promise<FinanceMetrics> {
  const result: FinanceMetrics = { months: [], lifetimeByCurrency: {} };

  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch (err: any) {
    result.error = err.message;
    return result;
  }

  const token = signJwt(env.keyId, env.issuerId, env.keyPath);
  const months = recentMonths();

  console.log(`[Finance] Fetching ${months.length} monthly reports...`);

  // Sequential on purpose: 13 requests, and Apple rate-limits this endpoint
  // more aggressively than salesReports. Speed is not the constraint here.
  const errors: string[] = [];
  for (const m of months) {
    try {
      result.months.push(await fetchOneMonth(m, env.vendorNumber, token));
    } catch (err: any) {
      errors.push(err.message);
      result.months.push({ month: m, proceedsByCurrency: {}, units: 0 });
    }
  }

  for (const m of result.months) {
    for (const [cur, amt] of Object.entries(m.proceedsByCurrency)) {
      result.lifetimeByCurrency[cur] = round2(
        (result.lifetimeByCurrency[cur] ?? 0) + amt
      );
    }
  }

  if (errors.length) result.error = errors.join('; ');
  return result;
}

// Run standalone for testing: npx tsx src/fetchFinance.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  fetchFinance()
    .then((d) => console.log(JSON.stringify(d, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
