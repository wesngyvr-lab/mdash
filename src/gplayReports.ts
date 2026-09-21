import { google } from 'googleapis';
import { unzipSync, strFromU8 } from 'fflate';

/**
 * Google Play bulk reports, read from the Play Console's Cloud Storage bucket.
 *
 * Play has no per-day downloads or revenue endpoint. The canonical source is a
 * set of CSVs the Console writes to `gs://pubsite_prod_<id>/`, which is why
 * `fetchGplay` shipped with downloads and revenue hard-coded to 0 and a note
 * saying "v1.1 will add Cloud Storage report parsing". This is that.
 *
 * The bucket was already configured in `.env` as GPLAY_REPORT_BUCKET and no
 * code ever read it, so the dashboard reported a confident 0 across every
 * window — including 365d — for a store that has been taking money since
 * August. A zero meaning "not implemented" is worse than an error, because it
 * reads as a finding.
 *
 * Two encoding traps, both real:
 *  - These CSVs are UTF-16LE with a BOM. Read as UTF-8 they do not throw —
 *    they yield NUL-separated text that still splits on commas, so the failure
 *    is silent and the output looks like data.
 *  - The bucket holds EVERY app on the developer account. Filtering by package
 *    name is mandatory; `app.butters` and `com.wesleyng.tilebuddy` share this
 *    one.
 */

const STORAGE = 'https://storage.googleapis.com/storage/v1/b';

export interface InstallDay {
  date: string;
  /** New device installs that day — a flow. */
  installs: number;
  /** Devices currently holding the app — a level, not a flow. */
  activeDevices: number;
}

export interface SubscriptionDay {
  date: string;
  productId: string;
  country: string;
  basePlan: string;
  newSubs: number;
  cancelled: number;
  /** Active on that date. A level restated daily — never sum across dates. */
  active: number;
}

type Client = Awaited<ReturnType<typeof getClient>>;

async function getClient(keyFile: string) {
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
  });
  return auth.getClient();
}

/** Bucket name from either a bare name or a `gs://bucket/path` URI. */
export function bucketName(raw: string): string {
  return raw.replace(/^gs:\/\//, '').split('/')[0].trim();
}

async function list(c: Client, bucket: string, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${STORAGE}/${bucket}/o?maxResults=1000&prefix=${encodeURIComponent(prefix)}`
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const res = await c.request<{ items?: { name: string }[]; nextPageToken?: string }>({ url });
    for (const i of res.data.items ?? []) names.push(i.name);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return names;
}

async function readCsv(c: Client, bucket: string, name: string): Promise<string[][]> {
  const res = await c.request({
    url: `${STORAGE}/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
    responseType: 'arraybuffer',
  });
  const buf = Buffer.from(res.data as ArrayBuffer);
  const text = (buf[0] === 0xff && buf[1] === 0xfe)
    ? buf.toString('utf16le')
    : buf.toString('utf8');
  return text
    .replace(/^﻿/, '')
    .trim()
    .split(/\r?\n/)
    .map(line => line.split(',').map(cell => cell.trim()));
}

/** `YYYYMM` strings covering the last `days`, newest first. */
export function monthsBack(days: number, now = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const span = Math.ceil(days / 28) + 1;
  for (let i = 0; i < span; i++) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

/**
 * Daily installs for one package.
 *
 * Reads `_overview.csv` per month and nothing else — the country, device and
 * language cuts restate the same totals along another axis, so summing them
 * together would multiply the count by the number of dimensions.
 */
export async function fetchInstalls(opts: {
  keyFile: string; bucket: string; packageName: string; days: number;
}): Promise<InstallDay[]> {
  const c = await getClient(opts.keyFile);
  const bucket = bucketName(opts.bucket);
  const wanted = new Set(monthsBack(opts.days).map(m =>
    `stats/installs/installs_${opts.packageName}_${m}_overview.csv`));

  const present = (await list(c, bucket, `stats/installs/installs_${opts.packageName}_`))
    .filter(n => wanted.has(n));

  const days: InstallDay[] = [];
  for (const name of present) {
    const rows = await readCsv(c, bucket, name);
    const head = rows[0].map(h => h.toLowerCase());
    const iDate = head.indexOf('date');
    const iInstalls = head.indexOf('daily device installs');
    const iActive = head.indexOf('active device installs');
    for (const r of rows.slice(1)) {
      if (!r[iDate]) continue;
      days.push({
        date: r[iDate],
        installs: Number(r[iInstalls] ?? 0) || 0,
        activeDevices: Number(r[iActive] ?? 0) || 0,
      });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Daily subscription rows per product and country.
 *
 * The only place Play states ACTIVE subscriber counts. PostHog counts purchase
 * events and cannot see a cancellation; the app's own database knows an expiry
 * date but not which store or which plan it came from. This knows both.
 */
export async function fetchSubscriptions(opts: {
  keyFile: string; bucket: string; packageName: string; days: number;
}): Promise<SubscriptionDay[]> {
  const c = await getClient(opts.keyFile);
  const bucket = bucketName(opts.bucket);
  const months = monthsBack(opts.days);

  const names = (await list(c, bucket, 'financial-stats/subscriptions/'))
    .filter(n => n.includes(opts.packageName))
    .filter(n => months.some(m => n.includes(`_${m}_`)));

  const out: SubscriptionDay[] = [];
  for (const name of names) {
    const rows = await readCsv(c, bucket, name);
    const head = rows[0].map(h => h.toLowerCase());
    const col = (want: string) => head.indexOf(want);
    for (const r of rows.slice(1)) {
      if (!r[col('date')]) continue;
      out.push({
        date: r[col('date')],
        productId: r[col('product id')] ?? '',
        country: r[col('country')] ?? '',
        basePlan: r[col('base plan id')] ?? '',
        newSubs: Number(r[col('new subscriptions')] ?? 0) || 0,
        cancelled: Number(r[col('cancelled subscriptions')] ?? 0) || 0,
        active: Number(r[col('active subscriptions')] ?? 0) || 0,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Active subscriptions on the most recent date any report covers.
 *
 * Deliberately NOT a sum over dates. `Active Subscriptions` is a level
 * restated every day, so adding them counts the same subscriber once per day —
 * a base of fourteen becomes a confident four hundred.
 */
export function activeOnLatestDate(rows: SubscriptionDay[]): {
  date: string | null;
  total: number;
  byPlan: Record<string, number>;
  byCountry: Record<string, number>;
} {
  if (rows.length === 0) return { date: null, total: 0, byPlan: {}, byCountry: {} };
  const latest = rows[rows.length - 1].date;
  const byPlan: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  let total = 0;
  for (const r of rows.filter(x => x.date === latest)) {
    total += r.active;
    const plan = r.basePlan || r.productId;
    byPlan[plan] = (byPlan[plan] ?? 0) + r.active;
    byCountry[r.country] = (byCountry[r.country] ?? 0) + r.active;
  }
  return { date: latest, total, byPlan, byCountry };
}


export interface SaleRow {
  /** Date the order was charged, `YYYY-MM-DD`. */
  date: string;
  sku: string;
  productType: string;
  country: string;
  /** Currency the buyer was charged in. Never FX-converted anywhere here. */
  currency: string;
  /** Price before tax, in `currency`. */
  itemPrice: number;
  status: string;
}

/**
 * Monthly sales reports — the only Play source with actual money in it.
 *
 * `financial-stats/subscriptions/` gives active COUNTS and no amounts;
 * `stats/installs/` gives installs. Revenue lives here, and in
 * `earnings/*.zip`, as zipped CSVs.
 *
 * Sales vs earnings: the sales report is per-transaction and refreshes within
 * a day or two (202609 was rewritten the morning of 2026-09-21), while
 * earnings is a monthly payout statement that lands weeks later — August's was
 * still the newest on 21 September. Sales is what a dashboard wants; earnings
 * is what reconciles to the bank.
 *
 * `Item Price` is pre-tax and thousands-separated in the buyer's own currency
 * ("249,000.00" IDR). It is NOT Google's 15% cut — that is applied later and is
 * not stated per row, so these are GROSS amounts.
 */
export async function fetchSales(opts: {
  keyFile: string; bucket: string; packageName: string; days: number;
}): Promise<SaleRow[]> {
  const c = await getClient(opts.keyFile);
  const bucket = bucketName(opts.bucket);
  const months = monthsBack(opts.days);

  const names = (await list(c, bucket, 'sales/'))
    .filter(n => n.endsWith('.zip'))
    .filter(n => months.some(m => n.includes(m)));

  const out: SaleRow[] = [];
  for (const name of names) {
    const res = await c.request({
      url: `${STORAGE}/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
      responseType: 'arraybuffer',
    });
    const files = unzipSync(new Uint8Array(res.data as ArrayBuffer));
    for (const [inner, bytes] of Object.entries(files)) {
      if (!inner.toLowerCase().endsWith('.csv')) continue;
      const rows = parseCsv(strFromU8(bytes).replace(/^\uFEFF/, ''));
      if (rows.length < 2) continue;
      const head = rows[0].map(h => h.toLowerCase());
      const col = (w: string) => head.indexOf(w);
      for (const r of rows.slice(1)) {
        if (r[col('package id')] !== opts.packageName) continue;
        out.push({
          date: r[col('order charged date')] ?? '',
          sku: r[col('sku id')] ?? '',
          productType: r[col('product type')] ?? '',
          country: r[col('country of buyer')] ?? '',
          currency: r[col('currency of sale')] ?? '',
          itemPrice: Number((r[col('item price')] ?? '0').replace(/,/g, '')) || 0,
          status: r[col('financial status')] ?? '',
        });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Splits a CSV line honouring double quotes.
 *
 * Required here and not for the other reports: `Item Price` is written
 * `"249,000.00"`, so a naive split on commas turns one Indonesian price into
 * two columns and silently shifts every field after it.
 */
function parseCsv(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(line => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

/**
 * Gross proceeds per currency for charged orders in a window.
 *
 * Kept per-currency and never summed into one number: these reports state
 * IDR, USD and CAD side by side, and adding them would require an FX rate
 * this tool has no business inventing. `AppMetrics.proceedsByCurrency` exists
 * for exactly this reason — the App Store fetcher made the same choice.
 */
export function proceedsInWindow(rows: SaleRow[], sinceMs: number): {
  byCurrency: Record<string, number>; paidUnits: number;
} {
  const byCurrency: Record<string, number> = {};
  let paidUnits = 0;
  for (const r of rows) {
    if (r.status !== 'Charged') continue;
    if (!r.date || Date.parse(r.date) < sinceMs) continue;
    byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + r.itemPrice;
    paidUnits++;
  }
  return { byCurrency, paidUnits };
}
