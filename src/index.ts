import 'dotenv/config';
import { fetchAsc } from './fetchAsc.js';
import { fetchGplay } from './fetchGplay.js';
import { fetchPosthog } from './fetchPosthog.js';
import { writeDashboard } from './render.js';
import type { DashboardData } from './types.js';

async function main() {
  console.log('Fetching from all sources in parallel...');

  const [appStoreResult, googlePlayResult, webMetricsResult] = await Promise.allSettled([
    fetchAsc(),
    fetchGplay(),
    fetchPosthog(),
  ]);

  const data: DashboardData = {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    appStore:
      appStoreResult.status === 'fulfilled'
        ? appStoreResult.value
        : {
            source: 'app_store',
            appName: process.env.APP_NAME ?? 'App',
            windows: {
              '7d': { downloads: 0, revenueUsd: 0 },
              '30d': { downloads: 0, revenueUsd: 0 },
              '90d': { downloads: 0, revenueUsd: 0 },
              '365d': { downloads: 0, revenueUsd: 0 },
            },
            rating: null,
            error: appStoreResult.reason?.message ?? 'fetch failed',
          },
    googlePlay:
      googlePlayResult.status === 'fulfilled'
        ? googlePlayResult.value
        : {
            source: 'google_play',
            appName: process.env.APP_NAME ?? 'App',
            windows: {
              '7d': { downloads: 0, revenueUsd: 0 },
              '30d': { downloads: 0, revenueUsd: 0 },
              '90d': { downloads: 0, revenueUsd: 0 },
              '365d': { downloads: 0, revenueUsd: 0 },
            },
            rating: null,
            error: googlePlayResult.reason?.message ?? 'fetch failed',
          },
    webMetrics: webMetricsResult.status === 'fulfilled' ? webMetricsResult.value : [],
  };

  const { dashboardPath, reviewPath, date } = writeDashboard(data);
  console.log(`\n✓ Dashboard: ${dashboardPath}`);
  console.log(`✓ Friday Review (created if missing): ${reviewPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
