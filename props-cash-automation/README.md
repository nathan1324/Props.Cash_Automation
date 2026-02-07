# Props.cash Automation

Local Windows app that authenticates to [props.cash](https://props.cash) via manual Google SSO, persists the session, and runs automated browser tasks on demand or on a daily schedule.

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org)
- **Git Bash** (optional but recommended on Windows)
- A Google account with access to props.cash

## Setup

```bash
# Clone / navigate to the project
cd props-cash-automation

# Install dependencies
npm install

# Install Playwright browsers (Chromium)
npx playwright install chromium

# Copy the env file
cp .env.example .env
```

> **Git Bash note:** All `npm run` commands work in Git Bash, PowerShell, and CMD.

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

### 2. Run Manually

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

### 3. Run Daily (Headless)

```bash
npm run run:daily
```

## CLI Flags

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
│   ├── authInit.ts         # Phase 1: manual headed auth
│   ├── runner.ts           # Phase 2: automated task runner
│   ├── selectors.ts        # Centralized selectors + constants
│   └── storageState.json   # Generated — browser session state
├── server/
│   └── index.ts            # Express server + dashboard
├── artifacts/
│   └── screenshots/        # Generated screenshots
├── logs/                   # Run summary JSONs
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
| Browser doesn't launch | Run `npx playwright install chromium` |
| Selectors don't match | Check if props.cash UI changed; update `selectors.ts` |
