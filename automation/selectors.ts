/**
 * Centralized selectors for props.cash
 *
 * All selectors use text-based or role-based locators to avoid brittle CSS.
 * If the props.cash UI changes, update these selectors here — no other files
 * need to change.
 */

export const SELECTORS = {
  /** Signals that the user is logged in */
  loginIndicators: {
    /** Navbar link that reads "NBA" — only visible when authenticated */
    nbaLink: (page: import('playwright').Page) =>
      page.getByRole('link', { name: 'NBA' }),

    /** Search input placeholder — only visible when authenticated */
    searchInput: (page: import('playwright').Page) =>
      page.getByPlaceholder('Search Players or Teams'),
  },

  /** Google SSO entry point */
  googleLogin: {
    continueWithGoogle: (page: import('playwright').Page) =>
      page.getByRole('button', { name: /continue with google/i }),
  },
  /** Props page — table and dropdown elements */
  propsPage: {
    /** The prop-type dropdown (native select, if present) */
    propsSelect: (page: import('playwright').Page) =>
      page.locator('select').first(),

    /** Dropdown trigger buttons (aria-haspopup variants) */
    dropdownTriggers: (page: import('playwright').Page) =>
      page.locator(
        'button[aria-haspopup="listbox"], button[aria-haspopup="menu"], button[aria-haspopup="true"], [role="combobox"]'
      ),

    /** Dropdown option by text */
    dropdownOption: (page: import('playwright').Page, optionText: string) =>
      page.getByRole('option', { name: optionText }),

    /** Table container */
    tableContainer: (page: import('playwright').Page) =>
      page.locator('table, [role="table"], [role="grid"]').first(),

    /** Table header cells */
    tableHeaders: (page: import('playwright').Page) =>
      page.locator('thead th, thead td, [role="columnheader"]'),

    /** Table body rows */
    tableRows: (page: import('playwright').Page) =>
      page.locator('tbody tr, [role="row"]:not(:has([role="columnheader"])):not(:first-child)'),

    /** Table cells within a row */
    tableCells: (row: import('playwright').Locator) =>
      row.locator('td, [role="cell"], [role="gridcell"]'),

    /** Loading/spinner indicator */
    loadingIndicator: (page: import('playwright').Page) =>
      page.locator('[class*="loading"], [class*="spinner"], [class*="skeleton"], [data-loading="true"]'),
  },
} as const;

/** How long to wait for table refresh after changing prop type (ms) */
export const TABLE_REFRESH_TIMEOUT = 15_000;

/** How long between scroll attempts for virtualised tables (ms) */
export const SCROLL_INTERVAL = 500;

/** Max scroll iterations before giving up */
export const MAX_SCROLL_ATTEMPTS = 120;

/** Retry count for individual prop scrapes */
export const SCRAPE_RETRY_COUNT = 3;

/** How long to wait for login indicators after manual auth (ms) */
export const AUTH_DETECT_TIMEOUT = 300_000; // 5 minutes

/** How long to wait for session verification on automated runs (ms) */
export const SESSION_VERIFY_TIMEOUT = 30_000; // 30 seconds

/** How long to wait for props table content to render (ms) */
export const CONTENT_LOAD_TIMEOUT = 30_000;

/** Default base URL */
export const DEFAULT_BASE_URL = 'https://props.cash';

/** Path to persisted browser state */
export const STORAGE_STATE_PATH = './automation/storageState.json';
