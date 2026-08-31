import 'dotenv/config';
import './http.js';
import { WINDOWS, WINDOW_DAYS, emptyWindows, type WebMetrics, type Window } from './types.js';

function loadEnv() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST ?? 'https://us.posthog.com';
  if (!apiKey) throw new Error('Missing POSTHOG_API_KEY');
  return { apiKey, host };
}

async function runQuery(
  host: string,
  apiKey: string,
  projectId: string,
  hogql: string
): Promise<any[][]> {
  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: { kind: 'HogQLQuery', query: hogql },
    }),
  });
  if (!res.ok) {
    throw new Error(`PostHog ${projectId}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { results?: any[][] };
  return data.results ?? [];
}

async function fetchProject(
  host: string,
  apiKey: string,
  projectId: string,
  siteName: string
): Promise<WebMetrics> {
  const result: WebMetrics = {
    site: siteName,
    projectId,
    windows: emptyWindows({ pageviews: 0, uniqueVisitors: 0 }),
    topPages: [],
  };

  // One scan for all four windows instead of four separate ones.
  //
  // The old loop ran a query per window, and the 365-day one used
  // count(DISTINCT distinct_id) — an exact distinct over a year of events.
  // That reliably hit PostHog's max execution time and returned a 504, so
  // wesley-ng.com's 365d row read 0. uniq() is ClickHouse's approximate
  // HyperLogLog count: far cheaper, and well inside tolerance for a
  // dashboard number.
  const windowSql = `
    SELECT
      countIf(timestamp >= now() - INTERVAL 7 DAY)                 AS pv7,
      uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY)     AS u7,
      countIf(timestamp >= now() - INTERVAL 30 DAY)                AS pv30,
      uniqIf(distinct_id, timestamp >= now() - INTERVAL 30 DAY)    AS u30,
      countIf(timestamp >= now() - INTERVAL 90 DAY)                AS pv90,
      uniqIf(distinct_id, timestamp >= now() - INTERVAL 90 DAY)    AS u90,
      count()                                                      AS pv365,
      uniq(distinct_id)                                            AS u365
    FROM events
    WHERE event IN ('$pageview', '$screen')
      AND timestamp >= now() - INTERVAL 365 DAY
  `;

  const errors: string[] = [];

  // Each query is isolated. Previously a single failure aborted the rest of
  // the function, so a timeout on the widest window also silently cost us
  // the top-pages list.
  try {
    const rows = await runQuery(host, apiKey, projectId, windowSql);
    const r = rows[0] ?? [];
    const n = (i: number) => Number(r[i] ?? 0);
    result.windows['7d'] = { pageviews: n(0), uniqueVisitors: n(1) };
    result.windows['30d'] = { pageviews: n(2), uniqueVisitors: n(3) };
    result.windows['90d'] = { pageviews: n(4), uniqueVisitors: n(5) };
    result.windows['365d'] = { pageviews: n(6), uniqueVisitors: n(7) };
  } catch (err) {
    errors.push(`windows: ${(err as Error).message}`);
  }

  try {
    const topSql = `
      SELECT properties.$pathname AS path, count() AS views
      FROM events
      WHERE event = '$pageview'
        AND timestamp >= now() - INTERVAL 30 DAY
        AND properties.$pathname IS NOT NULL
      GROUP BY path
      ORDER BY views DESC
      LIMIT 5
    `;
    const topRows = await runQuery(host, apiKey, projectId, topSql);
    result.topPages = topRows.map(([path, views]) => ({
      path: String(path ?? ''),
      views: Number(views ?? 0),
    }));
  } catch (err) {
    errors.push(`topPages: ${(err as Error).message}`);
  }

  if (errors.length) result.error = errors.join(' | ');

  return result;
}

function parseProjects(raw: string | undefined): Array<{ id: string; name: string }> {
  if (!raw) return [];
  // Format: "Site A:12345,Site B:67890"
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(':');
      if (idx === -1) {
        throw new Error(`Invalid POSTHOG_PROJECTS entry "${entry}" — expected "Name:ID"`);
      }
      return { name: entry.slice(0, idx).trim(), id: entry.slice(idx + 1).trim() };
    });
}

export async function fetchPosthog(): Promise<WebMetrics[]> {
  const { apiKey, host } = loadEnv();
  const projects = parseProjects(process.env.POSTHOG_PROJECTS);

  if (projects.length === 0) {
    console.warn('[PostHog] POSTHOG_PROJECTS not set, skipping');
    return [];
  }

  console.log(`[PostHog] Querying ${projects.length} project(s)...`);
  return Promise.all(
    projects.map((p) => fetchProject(host, apiKey, p.id, p.name))
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchPosthog()
    .then((data) => console.log(JSON.stringify(data, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
