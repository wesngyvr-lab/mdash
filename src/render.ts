import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { WINDOWS, type AppMetrics, type DashboardData, type WebMetrics } from './types.js';

const OUTPUT_DIR =
  process.env.DASHBOARD_OUTPUT_DIR ??
  `${process.env.HOME}/Workspace/WN Main/Dashboard`;

function todayLocalDate(): string {
  // YYYY-MM-DD in local time (so Friday's run files as Friday's date, not UTC)
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function appTable(m: AppMetrics): string {
  let out = '| Window | Downloads | Revenue (USD)\\* |\n|---|---|---|\n';
  for (const w of WINDOWS) {
    const { downloads, revenueUsd } = m.windows[w];
    out += `| ${w} | ${fmtNum(downloads)} | ${fmtUsd(revenueUsd)} |\n`;
  }
  return out;
}

function ratingLine(m: AppMetrics): string {
  if (!m.rating) return '_Rating: not available_';
  return `⭐ **${m.rating.average}** (n=${m.rating.count})`;
}

function appSection(title: string, m: AppMetrics): string {
  let s = `### ${title}\n\n`;
  if (m.error === 'Android not launched yet') {
    s += `_Android not launched yet — section will populate after Play Store release._\n`;
    return s;
  }
  s += appTable(m) + '\n';
  s += ratingLine(m) + '\n';
  if (m.error) s += `\n> ⚠️ ${m.error}\n`;
  return s;
}

function webTable(m: WebMetrics): string {
  let out = '| Window | Pageviews | Unique Visitors |\n|---|---|---|\n';
  for (const w of WINDOWS) {
    const { pageviews, uniqueVisitors } = m.windows[w];
    out += `| ${w} | ${fmtNum(pageviews)} | ${fmtNum(uniqueVisitors)} |\n`;
  }
  return out;
}

function webSection(m: WebMetrics): string {
  let s = `### ${m.site}\n\n`;
  s += webTable(m) + '\n';
  if (m.topPages.length > 0) {
    s += '**Top pages (30d):**\n';
    for (const p of m.topPages) {
      s += `- \`${p.path}\` — ${fmtNum(p.views)}\n`;
    }
    s += '\n';
  }
  if (m.error) s += `> ⚠️ ${m.error}\n\n`;
  return s;
}

export function render(data: DashboardData): string {
  const ts = data.generatedAt;
  const appName = process.env.APP_NAME ?? data.appStore.appName ?? 'App';
  let md = `# Revenue Dashboard\n\n_Generated: ${ts}_\n\n`;
  md += `## ${appName}\n\n`;
  md += appSection('App Store (iOS)', data.appStore);
  md += '\n';
  md += appSection('Google Play (Android)', data.googlePlay);
  md += '\n';
  md += `\\* Revenue in USD only — non-USD App Store proceeds excluded for v1.\n\n`;

  if (data.webMetrics.length > 0) {
    md += `## Web Analytics (PostHog)\n\n`;
    for (const w of data.webMetrics) {
      md += webSection(w);
    }
  }

  return md;
}

export function renderFridayReview(data: DashboardData, date: string): string {
  const dashLink = `[[Revenue Dashboard ${date}]]`;
  let md = `# Friday Review — ${date}\n\n`;
  md += `Dashboard: ${dashLink}\n\n`;
  md += `## Numbers (snapshot)\n\n`;
  md += `**App Store (iOS) downloads:** 7d ${data.appStore.windows['7d'].downloads} · 30d ${data.appStore.windows['30d'].downloads} · 90d ${data.appStore.windows['90d'].downloads}\n\n`;
  md += `**Google Play downloads:** _manual entry — pull from Play Console_\n\n`;
  for (const w of data.webMetrics) {
    md += `**${w.site} pageviews:** 7d ${w.windows['7d'].pageviews} · 30d ${w.windows['30d'].pageviews} (uniques: 7d ${w.windows['7d'].uniqueVisitors} · 30d ${w.windows['30d'].uniqueVisitors})\n\n`;
  }
  md += `## Synthesis\n\n`;
  md += `### Shipped this week\n- \n\n`;
  md += `### Stuck (2+ weeks)\n- \n\n`;
  md += `### Surface area check\n- New commitments this week (reversible/cheap, or expanding scope?):\n\n`;
  md += `### The one thing for next week\n- \n\n`;
  md += `## Manual entry\n\n`;
  md += `### Consulting\n`;
  md += `| Client | Engagement | Invoiced | Paid | Outstanding | Due |\n|---|---|---|---|---|---|\n`;
  md += `| | | | | | |\n\n`;
  md += `### Pipeline\n`;
  md += `| Lead | Stage | Est. $ | Next step | Last touch |\n|---|---|---|---|---|\n`;
  md += `| | Lead / Call / Proposal / Signed | | | |\n\n`;
  md += `### Socials\n`;
  md += `| Platform | Followers | Δ this week | Top post |\n|---|---|---|---|\n`;
  md += `| TikTok | | | |\n`;
  md += `| Instagram | | | |\n\n`;
  return md;
}

type WriteResult = { dashboardPath: string; reviewPath: string; date: string };

export function writeDashboard(data: DashboardData): WriteResult {
  const date = todayLocalDate();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const dashboardPath = `${OUTPUT_DIR}/Revenue Dashboard ${date}.md`;
  writeFileSync(dashboardPath, render(data), 'utf8');

  const reviewPath = `${OUTPUT_DIR}/Friday Review ${date}.md`;
  // Don't overwrite an existing review note — user may have filled it in
  // already. Only create if missing.
  try {
    writeFileSync(reviewPath, renderFridayReview(data, date), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // EEXIST = file already exists; that's intentional
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  return { dashboardPath, reviewPath, date };
}
