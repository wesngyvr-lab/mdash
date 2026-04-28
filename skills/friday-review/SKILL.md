---
name: friday-review
description: Use when the user wants to run their weekly review, types /friday-review, or says things like "do the Friday review", "run my weekly review", "review the week". Refreshes the mdash dashboard, opens this week's Friday Review note, and walks the user through synthesis prompts one at a time, updating the note as they answer.
---

# Friday Review Walker

## Overview

`mdash` (the dashboard aggregator at `~/path/to/mdash/` — set `MDASH_PATH` env var to point at it) writes two files into the configured output directory each run:
- `Revenue Dashboard YYYY-MM-DD.md` — overwritten each run
- `Friday Review YYYY-MM-DD.md` — created if missing, never overwritten

This skill orchestrates the weekly review: refresh the data, then walk the user through four synthesis prompts interactively, updating the Friday Review note as they answer.

## Workflow

1. **Refresh data**: run `cd $MDASH_PATH && npm run dashboard`. If it fails (laptop offline, expired keys), surface the error but proceed if data already exists in the output directory.

2. **Read the Friday Review note** at `<DASHBOARD_OUTPUT_DIR>/Friday Review <today's date>.md`. Use today's date in the user's local timezone, format `YYYY-MM-DD`. Get `DASHBOARD_OUTPUT_DIR` from the user's `.env` or default `~/Workspace/WN Main/Dashboard`.

3. **Surface the snapshot** — show a one-screen summary of the current numbers (App Store downloads, web pageviews/uniques per site, 7d and 30d). Pull from the dashboard file.

4. **Walk the four synthesis prompts ONE AT A TIME** — never all at once. After each answer, edit the corresponding section in the Friday Review note before moving on:
   - **Shipped this week** — what actually went live (releases, deliverables, content posted, decisions made)
   - **Stuck (2+ weeks)** — what's been on the list but not moved? For each: kill, delegate, or schedule?
   - **Surface area check** — any new commitments this week? Reversible/cheap, or expanding scope?
   - **The one thing for next week** — single most important. Push back if they name more than one.

5. **Final**: confirm the file is saved, print the path.

## Tone

Operator-grade. Skip warmth, get to the prompt. Push back on vague answers ("shipped a bunch" → "name three"). The point is forcing specificity.

## What NOT to do

- Don't dump all four prompts at once — that's journaling, not synthesis
- Don't fill in the synthesis from inference — those are the user's answers, not yours
- Don't suggest skipping "stuck" or "surface area" — those catch drift before it compounds
- Don't refresh the dashboard if it was already refreshed in this conversation (check `_Generated:` line)
- Don't overwrite an existing Friday Review note's filled sections — read first, only update empty ones

## Edge cases

- **Today isn't Friday**: still works. Use today's date.
- **Dashboard fetch fails**: proceed with whatever's in the existing file, flag failure.
- **No Friday Review file yet**: the dashboard run creates it. If aggregator hasn't run today, run it first.
- **User wants to skip a prompt**: respect it but flag the skip in a one-line note at the top of the file.
