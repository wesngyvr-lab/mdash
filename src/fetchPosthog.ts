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

  try {
    for (const w of WINDOWS) {
      const days = WINDOW_DAYS[w];
      const sql = `
        SELECT count() AS pageviews,
               count(DISTINCT distinct_id) AS uniques
        FROM events
        WHERE event IN ('$pageview', '$screen')
          AND timestamp >= now() - INTERVAL ${days} DAY
      `;
      const rows = await runQuery(host, apiKey, projectId, sql);
      const [pageviews = 0, uniques = 0] = rows[0] ?? [];
      result.windows[w] = {
        pageviews: Number(pageviews),
        uniqueVisitors: Number(uniques),
      };
    }

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
    const e = err as Error & { cause?: unknown };
    result.error = `${e.message}${e.cause ? ' | cause: ' + JSON.stringify(e.cause, Object.getOwnPropertyNames(e.cause)) : ''}`;
  }

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
