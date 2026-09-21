import 'dotenv/config';
import './http.js';
import { google } from 'googleapis';
import { WINDOWS, WINDOW_DAYS, emptyWindows, type AppMetrics, type Window } from './types.js';
import { pathToFileURL } from 'node:url';
import { fetchInstalls, fetchSubscriptions, activeOnLatestDate, fetchSales, proceedsInWindow } from './gplayReports.js';

// Google Play has no clean "downloads per day" API endpoint. The canonical
// source is bulk CSV reports in the Console's Cloud Storage bucket, read here
// via ./gplayReports.ts.
//
// Until 2026-09-21 this fetcher pulled reviews only and left downloads and
// revenue at 0 with an explanatory string in `error`. The dashboard rendered
// the 0 and dropped the note, so Play showed a confident zero across every
// window — including 365d — for a store that had been taking money since
// August. GPLAY_REPORT_BUCKET had been configured the whole time and nothing
// read it.
//
// Still not read here: `earnings/*.zip`, which is where actual proceeds live.
// Installs and active subscriptions come from the CSVs; revenue stays 0 and
// SAYS so, rather than implying none was earned.

function loadEnv() {
  const path = process.env.GPLAY_SERVICE_ACCOUNT_PATH;
  const pkg = process.env.GPLAY_PACKAGE_NAME;
  if (!path || !pkg) {
    throw new Error('Missing GPLAY_SERVICE_ACCOUNT_PATH or GPLAY_PACKAGE_NAME');
  }
  return { path, pkg };
}

export async function fetchGplay(): Promise<AppMetrics> {
  const appName = process.env.APP_NAME ?? 'App';
  const result: AppMetrics = {
    source: 'google_play',
    appName,
    windows: emptyWindows({ downloads: 0, revenueUsd: 0 }),
    rating: null,
  };

  if (process.env.GPLAY_ENABLED !== 'true') {
    result.error = 'Android not launched yet';
    return result;
  }

  const env = loadEnv();
  const bucket = process.env.GPLAY_REPORT_BUCKET;

  // Installs and active subscriptions from the report bucket.
  if (bucket) {
    try {
      const installs = await fetchInstalls({ keyFile: env.path, bucket, packageName: env.pkg, days: 365 });
      const today = Date.now();
      for (const w of WINDOWS) {
        const since = today - WINDOW_DAYS[w] * 86_400_000;
        result.windows[w].downloads = installs
          .filter(d => Date.parse(d.date) >= since)
          .reduce((n, d) => n + d.installs, 0);
      }

      const subs = await fetchSubscriptions({ keyFile: env.path, bucket, packageName: env.pkg, days: 90 });
      const active = activeOnLatestDate(subs);
      result.activeSubscriptions = active;

      const latest = installs.at(-1);
      result.reportsThrough = latest?.date ?? null;
      result.activeDevices = latest?.activeDevices ?? null;

      // Gross proceeds from the monthly sales reports. Per-currency and never
      // FX-converted — these rows carry IDR, USD and CAD side by side.
      const sales = await fetchSales({ keyFile: env.path, bucket, packageName: env.pkg, days: 365 });
      for (const w of WINDOWS) {
        const since = today - WINDOW_DAYS[w] * 86_400_000;
        const { byCurrency, paidUnits } = proceedsInWindow(sales, since);
        result.windows[w].proceedsByCurrency = byCurrency;
        result.windows[w].paidUnits = paidUnits;
        // revenueUsd stays USD-only on purpose: it is not the total, and the
        // dashboard renders proceedsByCurrency beside it.
        result.windows[w].revenueUsd = byCurrency.USD ?? 0;
      }
      result.salesThrough = sales.at(-1)?.date ?? null;
    } catch (err) {
      result.error = `Play reports: ${(err as Error).message}`;
    }
  } else {
    result.error = 'GPLAY_REPORT_BUCKET not set — downloads and subscriptions unavailable';
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.path,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const publisher = google.androidpublisher({ version: 'v3', auth });

    // Reviews: returns up to 7 days of recent reviews (API limitation)
    console.log(`[Play] Fetching recent reviews for ${env.pkg}...`);
    const reviewsRes = await publisher.reviews.list({
      packageName: env.pkg,
      maxResults: 100,
    });
    const reviews = reviewsRes.data.reviews ?? [];
    if (reviews.length > 0) {
      const ratings: number[] = [];
      for (const r of reviews) {
        const star = r.comments?.[0]?.userComment?.starRating;
        if (typeof star === 'number') ratings.push(star);
      }
      if (ratings.length > 0) {
        const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        result.rating = { average: Number(avg.toFixed(2)), count: ratings.length };
      }
    }
  } catch (err) {
    result.error = `Google Play API error: ${(err as Error).message}`;
  }

  return result;
}

// pathToFileURL, not a template string: import.meta.url percent-encodes the
// path, so a directory containing a space ("03 Consulting") never matches a
// hand-built `file://` + argv[1]. This guard silently stopped firing when the
// repo moved into a folder with a space in its name, which is why the npm
// `test:*` scripts printed nothing at all.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchGplay()
    .then((data) => console.log(JSON.stringify(data, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
