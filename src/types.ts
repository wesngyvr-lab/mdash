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
    revenueUsd: number;
  }>;
  rating: { average: number; count: number } | null;
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
  webMetrics: WebMetrics[];
};

export function emptyWindows<T extends Record<string, number>>(
  shape: T
): Record<Window, T> {
  return Object.fromEntries(
    WINDOWS.map((w) => [w, { ...shape }])
  ) as Record<Window, T>;
}
