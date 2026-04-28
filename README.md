# mdash

A markdown-first revenue dashboard for solo operators. Pulls App Store Connect, Google Play, and PostHog into one weekly report you read in Obsidian (or any markdown editor). Bundles a Claude Code skill that walks you through a Friday review using the freshly-pulled numbers.

If you can't see the numbers, you can't manage to them. mdash gives you the dashboard a single-operator business actually needs — without paying $50/month for tools designed for ops teams of 12.

---

## What it pulls

| Source | What | Notes |
|---|---|---|
| **App Store Connect** | Daily downloads + USD revenue, last 365 days | Requires API key with `Finance` role |
| **Google Play** | Auth + reviews API (downloads/revenue placeholder for v1) | Optional. Enable once Android is live |
| **PostHog** | Pageviews, unique visitors, top pages — per project | Multi-project supported |

Output: two markdown files per run, written to a directory you choose (defaults to an Obsidian vault path):
- `Revenue Dashboard YYYY-MM-DD.md` — auto-refreshed each run, fully overwritten
- `Friday Review YYYY-MM-DD.md` — created if missing, **never overwritten** (your synthesis is safe)

---

## Quickstart

```bash
git clone https://github.com/wesngyvr-lab/mdash.git
cd mdash
npm install
cp .env.example .env
# Fill in .env (see "Configuration" below)
npm run dashboard
```

The dashboard markdown will appear at `$DASHBOARD_OUTPUT_DIR/Revenue Dashboard <today>.md`. Open it.

---

## Configuration

All config lives in `.env`. See `.env.example` for the full template with inline instructions.

### App Store Connect

1. **Generate an API key**: appstoreconnect.apple.com → Users and Access → Integrations → Team Keys → **+**.
   Role must be **Finance** (or higher) — `Developer` does not have access to sales reports.
2. Download the `.p8` file (only shown once) into `./secrets/asc-key.p8`.
3. Find your **Vendor Number**: appstoreconnect.apple.com → Payments and Financial Reports (top of page, 8 digits).
4. Find your **App ID**: numeric ID from the App Information page.
5. Fill in `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`, `ASC_VENDOR_NUMBER`, `ASC_APP_ID` in `.env`.

### PostHog

1. **Create a Personal API Key**: PostHog → Settings → Personal API Keys.
   Scopes: `Query: Read`, `Project: Read`.
2. **Find each project's ID** (numeric, in URL: `/project/<number>`).
3. Fill in `.env`:
   ```
   POSTHOG_API_KEY=phx_...
   POSTHOG_HOST=https://us.posthog.com   # or eu.posthog.com
   POSTHOG_PROJECTS=Mobile App:123456,Marketing Site:789012
   ```
   `POSTHOG_PROJECTS` format: comma-separated `Display Name:Project ID` pairs.

### Google Play (optional)

Skip this section if you haven't shipped Android yet — set `GPLAY_ENABLED=false` and the dashboard will print "not launched yet" instead of zeros.

When you're ready:
1. Create a service account in GCP, download JSON key into `./secrets/gplay-service-account.json`.
2. Enable **Google Play Android Developer API** on the GCP project.
3. Invite the service account email in Play Console → Users and permissions, granting "View app information" + "View financial data".
4. Set `GPLAY_ENABLED=true` and fill `GPLAY_PACKAGE_NAME` (e.g., `com.example.myapp`).

> **Heads up**: Google Play has no clean download-count API. v1 only proves auth + pulls recent reviews. Full installs/revenue from Cloud Storage bulk reports is on the v1.1 list.

---

## The Friday review skill

A bundled Claude Code skill at `skills/friday-review/SKILL.md` walks you through your weekly review using the freshly-pulled numbers. Triggered when you type `/friday-review` or say "let's do my weekly review".

The skill is opinionated — it pushes back on vague answers ("shipped a bunch of stuff" → "name three") and refuses to let you name more than one priority for next week. The point is forcing specificity, not journaling.

**Install:**
```bash
mkdir -p ~/.claude/skills
cp -r skills/friday-review ~/.claude/skills/
```
Restart Claude Code. Type `/friday-review` to verify.

The skill expects `MDASH_PATH` env var to point at your `mdash` checkout. Add to your shell profile:
```bash
export MDASH_PATH="$HOME/path/to/mdash"
```

---

## Automating the weekly run (macOS launchd)

A template plist is at `launchd/com.example.mdash.plist.template`. It runs the dashboard every Friday at 3pm local and fires a macOS notification when done.

```bash
# Replace placeholders, save to LaunchAgents
sed -e "s|{{HOME}}|$HOME|g" \
    -e "s|{{NPM_BIN}}|$(which npm)|g" \
    -e "s|{{LABEL}}|com.yourname.mdash|g" \
    launchd/com.example.mdash.plist.template \
    > ~/Library/LaunchAgents/com.yourname.mdash.plist

# Load
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yourname.mdash.plist

# Manual trigger to verify
launchctl kickstart -k gui/$UID/com.yourname.mdash
```

Pair with a Friday 3:30pm calendar reminder — by then the numbers are fresh, the Friday Review note is created, and you're ready to type `/friday-review` in Claude.

---

## Design choices worth flagging

- **Markdown out, not a web UI.** A dashboard you have to log into doesn't get checked. A markdown file in your second brain gets read every Friday because that's where you already are.
- **Manual run by default.** The act of typing `npm run dashboard` (or letting launchd run it) is the management. Adding more automation makes the numbers easier to ignore.
- **Free tier only.** No Datadog, no Databox, no $30/mo dashboard tools. Apple, Google, and PostHog APIs are all free for the use case mdash targets.
- **TypeScript with `tsx` runner.** No build step. Edit and run.
- **IPv4-forced fetch.** Node's bundled undici has a dual-stack issue on macOS where `fetch()` times out trying IPv6 even when curl succeeds. mdash forces IPv4 globally — see `src/http.ts`.
- **No history in v1.** Each run is a snapshot. Old dated files become the history naturally. Trend lines are a v1.1 problem only if anyone asks.

---

## v1.1 backlog

- Google Play installs/revenue from Cloud Storage bulk reports
- App Store rating count + average (no clean API; needs scrape or manual entry)
- HTML output as an alternative to markdown
- Multi-app support (currently one app per `.env`)

---

## License

MIT. See [LICENSE](./LICENSE).

---

Built by [Wesley Ng](https://wesley-ng.com) for his own use, then packaged because the alternatives cost too much for what they do.
