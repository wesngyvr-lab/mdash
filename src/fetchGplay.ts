import 'dotenv/config';
import './http.js';
import { google } from 'googleapis';
import { WINDOWS, WINDOW_DAYS, emptyWindows, type AppMetrics, type Window } from './types.js';

// Google Play has no clean "downloads per day" API endpoint.
// The canonical source is bulk CSV reports in a Cloud Storage bucket
// (e.g. gs://pubsite_prod_xxxx/stats/installs/...).
//
// For v1, this fetcher:
//   - Authenticates with the service account (proves the JSON key works)
//   - Pulls the last 7 days of reviews via androidpublisher.reviews.list
//     to derive a recent rating average
//   - Leaves downloads/revenue as 0 with a note in `error`
//
// v1.1 will add Cloud Storage report parsing for full install counts.

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
  result.error = 'Downloads/revenue require GCS bucket setup — manual entry for v1';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchGplay()
    .then((data) => console.log(JSON.stringify(data, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
