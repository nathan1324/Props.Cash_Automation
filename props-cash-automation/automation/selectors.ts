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
} as const;

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
