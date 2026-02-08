# Props.cash Automation

Local Windows app that authenticates to [props.cash](https://props.cash) via manual Google SSO, persists the session, and runs automated browser tasks on demand or on a daily schedule. Includes a full **NBA props scraper** that extracts all player prop data across 23 categories and persists it to a PostgreSQL (Supabase) database for historical analysis.

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Git Bash** (optional but recommended on Windows)
- A Google account with access to props.cash
- **PostgreSQL database** (optional) — [Supabase](https://supabase.com) free tier recommended for cloud persistence

## Setup

```bash
# Clone / navigate to the project
cd props-cash-automation

# Install dependencies
npm install

# Install Playwright browsers (Chromium)
npx playwright install chromium

# Copy the env file and configure
cp .env.example .env
```

Edit `.env` and set your `DATABASE_URL` if you want database persistence:

```
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

> **Supabase users:** Use the **connection pooler** URL (Session mode), not the direct connection URL.

> **Git Bash note:** All `npm run` commands work in Git Bash, PowerShell, and CMD.

### Database Setup

If using database persistence, run the migration to create the required tables:

```bash
# Using psql
psql $DATABASE_URL -f automation/db/migration.sql

# Or paste the contents of automation/db/migration.sql into your Supabase SQL editor
```

This creates two tables:
- `scrape_runs` — metadata for each scrape session
- `prop_rows` — individual player prop data with UPSERT support

## Quick Start

### 1. Initialize Authentication (one-time)

```bash
npm run init:auth
```

This opens a **visible** browser window.  You must:

1. Click **"Continue with Google"** on props.cash
2. Complete Google login + any 2FA prompts **manually**
3. Wait — the script detects login automatically and saves the session

The session is saved to `automation/storageState.json`.
**No credentials are stored** — only browser cookies and storage state.

### 2. Run Automation Manually

**CLI (headed browser):**

```bash
npm run run:manual
```

**Web dashboard:**

```bash
npm run server
# Open http://localhost:3000
# Click "Run Automation"
```

### 3. Scrape NBA Props

Scrape all 23 prop categories from props.cash and save to JSON/CSV files (and optionally to the database):

```bash
# Headed browser (watch it work)
npm run scrape

# Headless (background)
npm run scrape:headless

# Debug mode (saves screenshots + HTML per prop)
npm run scrape:debug

# Discover mode (lists all dropdown options and exits)
npm run scrape:discover
```

#### Scraper CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--headless=true\|false` | `false` (scrape) / `true` (scrape:headless) | Show or hide the browser |
| `--debug=true\|false` | `false` | Save debug screenshots and HTML per prop |
| `--date=YYYY-MM-DD` | today | Override the scrape date |
| `--discover` | — | List dropdown options and exit (for calibration) |
| `--limitProps=N` | all | Only scrape the first N props |
| `--prop="Name"` | — | Scrape a single prop by label |
| `--no-db` | — | Skip database persistence |

#### Scraper Output

Each scrape produces:
- `artifacts/scrapes/YYYY-MM-DD/nba_<prop>.json` — per-prop JSON
- `artifacts/scrapes/YYYY-MM-DD/nba_<prop>.csv` — per-prop CSV
- `artifacts/scrapes/YYYY-MM-DD/nba_all_props.json` — combined JSON
- `logs/scrape_<timestamp>.json` — run log with summary and errors

**Props scraped** (23 categories): Pts, Ast, Reb, Reb+Ast, Pts+Reb+Ast, Pts+Reb, Pts+Ast, 3PTM, Fantasy Score, Double Double, Triple Double, Turnovers, Steals+Blocks, Steals, Blocks, 1st Basket, Dunks, Def Reb, Off Reb, FG Attempts, FG Made, Free Throws, 3PTA

**Data fields per row:** Player name, team, status, line, odds over/under, projection, diff, DVP, hit rates (25/26, H2H, L5, L10, L20, 24/25), and raw cell data.

### 4. Run Daily (Headless)

```bash
npm run run:daily
```

## Electron Desktop App

Launch the desktop app with one-click access to all features:

```bash
npm run electron:build && npx electron .
```

The desktop app provides:

- **Auth status** indicator (missing / valid / expired)
- **Init Auth** button — launches the headed auth flow
- **Run Automation** button — triggers a headed run
- **Scrape Props** button — runs the full NBA props scraper
- **Live console output** — streams real-time progress
- **Last Run / Last Scrape** summaries with timestamps, row counts, and DB status
- **Daily scheduler** — configure a daily scrape time with enable/disable toggle
- **Data Browser** — query and browse scraped data from the database with:
  - Date picker (auto-loads most recent)
  - Prop filter dropdown
  - Player search
  - Sort by player, line, diff, projection, or DVP
  - Color-coded diff values (green positive, red negative)

## Web Dashboard

```bash
npm run server
```

Opens at `http://localhost:3000` with:

- **Auth status** indicator (missing / valid / expired)
- **Init Auth** button — launches the headed auth flow
- **Run Automation** button — triggers a headed run
- **Live log output** — streams console output in real-time
- **Last run** summary with timestamp, URL, and screenshot path

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Auth status, last run info, running state |
| `POST` | `/api/init-auth` | Launch auth init flow |
| `POST` | `/api/run` | Trigger automation run |
| `GET` | `/api/logs` | Stream live process output |

## CLI Flags (Runner)

The runner accepts these flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--headless=true\|false` | `true` (daily) / `false` (manual) | Show or hide the browser |
| `--url=<url>` | `https://props.cash` | Override the target URL |
| `--debug=true\|false` | `false` | Enable verbose logging |

Example:

```bash
npx tsx automation/runner.ts --headless=false --debug=true
```

## Scheduling with Windows Task Scheduler

To run daily at a specific time:

1. Open **Task Scheduler** (`taskschd.msc`)
2. Click **Create Basic Task**
3. Set the trigger (e.g., Daily at 8:00 AM)
4. Action: **Start a program**
5. Configure:

| Field | Value |
|-------|-------|
| Program | `C:\Program Files\nodejs\npm.cmd` |
| Arguments | `run run:daily` |
| Start in | `C:\Users\natha\props-cash-automation` |

6. In the task properties, check **"Run whether user is logged on or not"**
7. Check **"Run with highest privileges"** if needed

The task will:
- Exit with code `0` on success, non-zero on failure
- Write a run summary to `logs/run_<timestamp>.json`
- Save a screenshot to `artifacts/screenshots/props_<timestamp>.png`

## Re-authentication

Sessions expire periodically (Google cookies typically last days to weeks).

If you see `Auth expired — run init:auth again`:

```bash
npm run init:auth
```

The old `storageState.json` is overwritten automatically.

## Updating Selectors

If props.cash changes its UI, update `automation/selectors.ts`:

```typescript
export const SELECTORS = {
  loginIndicators: {
    // Change these if the navbar or search UI changes
    nbaLink: (page) => page.getByRole('link', { name: 'NBA' }),
    searchInput: (page) => page.getByPlaceholder('Search Players or Teams'),
  },
  googleLogin: {
    continueWithGoogle: (page) =>
      page.getByRole('button', { name: /continue with google/i }),
  },
};
```

All selectors are centralized in this one file — no other code needs to change.

## How Google SSO Session Reuse Works

1. **Manual login:** You authenticate with Google in a real browser window.  Google sets HTTP-only cookies on the `props.cash` domain (and possibly `accounts.google.com`).

2. **State capture:** Playwright's `context.storageState()` serializes all cookies, localStorage, and sessionStorage from the browser context into a JSON file.

3. **State replay:** On subsequent runs, `browser.newContext({ storageState: ... })` injects those cookies and storage entries back into a fresh browser context — effectively cloning your logged-in session.

4. **No credentials stored:** The JSON file contains session tokens (cookies), not your username or password. These tokens expire naturally and must be refreshed by running `init:auth` again.

5. **No Google automation:** The app never types into Google login fields, never bypasses CAPTCHAs, and never intercepts 2FA. All Google interaction is manual.

## Project Structure

```
props-cash-automation/
├── automation/
│   ├── authInit.ts              # Manual headed auth flow
│   ├── runner.ts                # Automated task runner
│   ├── scrapeCli.ts             # Scraper CLI entry point
│   ├── selectors.ts             # Centralized selectors + constants
│   ├── storageState.json        # Generated — browser session state
│   ├── scrape/
│   │   ├── helpers.ts           # Types, file I/O, CSV, parsing
│   │   └── nbaPropsScraper.ts   # Core scraper (discover, select, extract)
│   └── db/
│       ├── client.ts            # PostgreSQL connection pool
│       ├── migration.sql        # Database schema (scrape_runs, prop_rows)
│       └── persistScrape.ts     # UPSERT scrape data to database
├── electron/
│   ├── main.ts                  # Electron main process + IPC handlers
│   ├── preload.ts               # Context bridge API
│   ├── dbQuery.ts               # Database queries for Data Browser
│   └── renderer/
│       ├── index.html           # Desktop app UI
│       ├── app.js               # UI logic + Data Browser
│       └── styles.css           # Dark theme styles
├── server/
│   └── index.ts                 # Express server + web dashboard
├── artifacts/
│   ├── screenshots/             # Generated screenshots
│   └── scrapes/                 # Scraper output (JSON + CSV per date)
├── logs/                        # Run and scrape summary JSONs
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `No storageState.json found` | Run `npm run init:auth` first |
| `Auth expired` | Run `npm run init:auth` to re-authenticate |
| `Another run is already in progress` | Wait for the current run to finish, or delete `automation/.runner.lock` |
| `Another scrape is already in progress` | Wait for the current scrape to finish, or delete `automation/.scraper.lock` |
| Browser doesn't launch | Run `npx playwright install chromium` |
| Selectors don't match | Check if props.cash UI changed; update `selectors.ts` |
| `DATABASE_URL not set` | Add `DATABASE_URL` to your `.env` file |
| DB connection failed | Check your connection string; Supabase users should use the pooler URL |
| Data Browser empty | Run a scrape first (`npm run scrape`) to populate the database |
| Timezone issues in Data Browser | Ensure you're using the latest code with `date_iso::text` casts |
