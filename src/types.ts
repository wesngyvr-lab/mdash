export type Window = '7d' | '30d' | '90d' | '365d';

export const WINDOWS: Window[] = ['7d', '30d', '90d', '365d'];

export const WINDOW_DAYS: Record<Window, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

export type AppMetrics = {
  source: 'app_store' | 'google_play';
  appName: string;
  windows: Record<Window, {
    downloads: number;
    /** USD-denominated proceeds only. Kept because most stores report some
     *  USD, but it is NOT the total — see proceedsByCurrency. */
    revenueUsd: number;
    /** Proceeds keyed by currency of proceeds. Never FX-converted. */
    proceedsByCurrency?: Record<string, number>;
    /** Units on rows that carried proceeds (paid conversions, not downloads). */
    paidUnits?: number;
  }>;
  rating: { average: number; count: number } | null;
  /** How far the underlying reports actually reach.
   *
   *  A store that has published nothing for a week still answers every
   *  request — Apple returns 404 per missing day — so the aggregate comes
   *  back as a clean `0`. Without this, a reporting outage and a week of no
   *  sales render identically, and the dashboard states the wrong one as
   *  fact. Whoever reads a window needs to know it is covered before they
   *  read the number in it. */
  coverage?: {
    /** Newest date (`YYYY-MM-DD`) that returned any rows, or null if none did. */
    latestDataDate: string | null;
    /** Consecutive days, ending yesterday, for which no report exists. */
    missingRecentDays: number;
  };
  /** Play only: active subscribers on the latest date the reports cover.
   *  The one place ACTIVE counts exist — PostHog sees purchases and never
   *  cancellations; the app database has an expiry but not the store or plan. */
  activeSubscriptions?: { date: string | null; total: number; byPlan: Record<string, number>; byCountry: Record<string, number> };
  /** Play reports lag by a few days. Render this so a stale figure cannot be
   *  read as today's. */
  reportsThrough?: string | null;
  /** Latest charged-order date in the sales reports. Refreshes faster than
   *  the install CSVs, so the two lag differently and both are surfaced. */
  salesThrough?: string | null;
  /** Devices currently holding the app — a level, unlike downloads. */
  activeDevices?: number | null;
  error?: string;
};

export type WebMetrics = {
  site: string;
  projectId: string;
  windows: Record<Window, {
    pageviews: number;
    uniqueVisitors: number;
  }>;
  topPages: Array<{ path: string; views: number }>;
  error?: string;
};

export type DashboardData = {
  generatedAt: string;
  appStore: AppMetrics;
  googlePlay: AppMetrics;
  /** App Store proceeds from the FINANCIAL report — see fetchFinance.ts for
   *  why revenue can't come from the same place as downloads. */
  finance?: import('./fetchFinance.js').FinanceMetrics;
  webMetrics: WebMetrics[];
};

export function emptyWindows<T extends Record<string, number>>(
  shape: T
): Record<Window, T> {
  return Object.fromEntries(
    WINDOWS.map((w) => [w, { ...shape }])
  ) as Record<Window, T>;
}
