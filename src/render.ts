import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { WINDOWS, WINDOW_DAYS, type AppMetrics, type DashboardData, type WebMetrics } from './types.js';
import type { FinanceMetrics } from './fetchFinance.js';

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

/** Days of missing reports below which the lag is Apple's normal publishing
 *  delay rather than something the reader needs to act on. */
const LAG_TOLERANCE_DAYS = 3;

function appTable(m: AppMetrics): string {
  const missing = m.coverage?.missingRecentDays ?? 0;
  const stale = missing >= LAG_TOLERANCE_DAYS;

  let out = '| Window | Downloads | Paid | Proceeds |\n|---|---|---|---|\n';
  for (const w of WINDOWS) {
    // A window shorter than the reporting gap contains no reported days at
    // all, so its totals are zero for want of data, not for want of sales.
    // Printing "0" there asserts something the reports do not support.
    if (missing >= WINDOW_DAYS[w]) {
      out += `| ${w} | no data | no data | no data |\n`;
      continue;
    }

    const { downloads, proceedsByCurrency, paidUnits } = m.windows[w];
    const entries = Object.entries(proceedsByCurrency ?? {}).filter(([, v]) => v !== 0);
    const money = entries.length
      ? entries
          .sort((a, b) => b[1] - a[1])
          .map(([cur, amt]) => fmtMoney(amt, cur))
          .join(' · ')
      : '—';
    // A partly covered window is a real total over a shorter span than its
    // label claims, so flag it rather than let the label speak for it — but
    // only once the gap exceeds normal publishing lag, or every row carries a
    // warning every day and the mark stops meaning anything.
    const partial = stale ? ' ⚠️' : '';
    out += `| ${w}${partial} | ${fmtNum(downloads)} | ${fmtNum(paidUnits ?? 0)} | ${money} |\n`;
  }
  return out;
}

/** Warns when the store's reports lag far enough to distort every window. */
function coverageNote(m: AppMetrics): string {
  const c = m.coverage;
  if (!c) return '';
  if (c.latestDataDate === null) {
    return `\n> ⚠️ No sales reports available for any of the last 365 days. Check the vendor number and the API key's Sales and Reports access.\n`;
  }
  if (c.missingRecentDays < LAG_TOLERANCE_DAYS) return '';
  return (
    `\n> ⚠️ **Reports stop at ${c.latestDataDate}** — ${c.missingRecentDays} days with no report. ` +
    `Windows marked ⚠️ cover less time than their label says, and shorter windows have no data at all. ` +
    `Check Sales and Trends in App Store Connect. If it still shows sales, this is the wrong vendor number — ` +
    `an account can hold several, and reports move between them. If it is also empty, the gap is Apple's.\n`
  );
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
  s += coverageNote(m);
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

function fmtMoney(amount: number, currency: string): string {
  try {
    return amount.toLocaleString('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    // Unknown currency code — show the number with the code beside it.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function financeSection(f: FinanceMetrics): string {
  let s = '### Revenue (App Store proceeds)\n\n';

  const lifetime = Object.entries(f.lifetimeByCurrency).filter(([, v]) => v !== 0);
  if (lifetime.length === 0) {
    s += '_No proceeds recorded in the last 13 fiscal months._\n';
    if (f.error) s += `\n> ⚠️ ${f.error}\n`;
    return s;
  }

  s += '**Lifetime (last 13 fiscal months):** ';
  s += lifetime.map(([cur, amt]) => `**${fmtMoney(amt, cur)}**`).join(' · ');
  s += '\n\n';

  s += '| Fiscal month | Units | Proceeds |\n|---|---|---|\n';
  for (const m of f.months) {
    const entries = Object.entries(m.proceedsByCurrency).filter(([, v]) => v !== 0);
    if (entries.length === 0) continue; // skip empty months, they add nothing
    const amounts = entries.map(([cur, amt]) => fmtMoney(amt, cur)).join(' · ');
    s += `| ${m.month} | ${fmtNum(m.units)} | ${amounts} |\n`;
  }
  s += '\n_Proceeds are what Apple pays you, after its cut. Reported per fiscal';
  s += ' month (Apple fiscal months do not match calendar months) and never';
  s += ' currency-converted._\n';

  if (f.error) s += `\n> ⚠️ ${f.error}\n`;
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
  if (data.finance) {
    md += financeSection(data.finance);
    md += '\n';
  }
  md += `_Proceeds are what Apple pays after its cut, in the currency of the sale._\n`;
  md += `_Never FX-converted — a made-up rate in a revenue figure is worse than an honest split._\n\n`;

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
  // Same reasoning as appTable: during a reporting gap these read as real
  // zeros, and this line is the one people actually paste into a review.
  const iosDl = (w: '7d' | '30d' | '90d') =>
    (data.appStore.coverage?.missingRecentDays ?? 0) >= WINDOW_DAYS[w]
      ? 'no data'
      : String(data.appStore.windows[w].downloads);
  md += `**App Store (iOS) downloads:** 7d ${iosDl('7d')} · 30d ${iosDl('30d')} · 90d ${iosDl('90d')}\n\n`;
  if ((data.appStore.coverage?.missingRecentDays ?? 0) >= 3) {
    md += `> ⚠️ App Store reports stop at ${data.appStore.coverage?.latestDataDate}. Treat the iOS numbers above as covering less time than their labels say.\n\n`;
  }
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
