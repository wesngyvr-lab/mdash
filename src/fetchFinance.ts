// App Store revenue as Apple has FORMALLY ACCOUNTED it, from the FINANCIAL
// report. This is the reconciliation view: what Apple says it owes/paid.
//
// It is not the near-real-time number. fetchAsc reads the daily SALES report,
// which carries proceeds on in-app-purchase rows within a day or two — that is
// the source for the dashboard's 7d/30d/90d windows. The financial report lags
// the sale by roughly a month, so recent revenue is simply absent from it.
//
// Two things to know:
//   - Report dates are Apple FISCAL months, not calendar months. See
//     recentMonths() — getting this wrong silently returns the wrong period.
//   - A month with no sales returns HTTP 404 "There were no sales for the date
//     specified." That is a zero, not a failure.
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

/** Report dates as `FY-MM`, newest first.
 *
 *  These are Apple FISCAL months, not calendar months. Apple's fiscal year
 *  starts in late September, so FY2026 M1 is October 2025 and FY2026 M8 came
 *  back spanning 05/03/2026..05/30/2026. Passing a calendar month here asks
 *  for a period roughly three months earlier than intended — which is how a
 *  13-month sweep managed to miss every month the app was monetized.
 *
 *  Calendar month -> fiscal month is +4 (Oct = 1), rolling the year. The exact
 *  boundaries drift by a few days each year; the report's own Start/End Date
 *  columns are the authority, which is why the rendered table shows them. */
function recentMonths(now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const cal = d.getUTCMonth() + 1; // 1-12
    const fiscalMonth = ((cal + 2) % 12) + 1; // Oct(10) -> 1, Jan(1) -> 4
    const fiscalYear = cal >= 10 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
    out.push(`${fiscalYear}-${String(fiscalMonth).padStart(2, '0')}`);
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
