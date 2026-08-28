export const OFFICE_WINDOW_NAME = "homardclaw-office-window";

/**
 * The slice of the browsing-context tree the office-window helpers rely on.
 * The real `Window` satisfies this structurally; tests pass fakes because
 * vitest runs in a node environment with no global `window`.
 */
export interface OfficeFrameWindow {
  self: unknown;
  top: { location: { href: string } } | null;
  name: string;
  location: { assign: (url: string) => void };
}

function defaultWindow(): OfficeFrameWindow | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/** True inside the desktop office's same-origin parchment iframe. */
export function isOfficeWindowFrame(
  win: OfficeFrameWindow | undefined = defaultWindow(),
): boolean {
  return (
    win !== undefined && win.self !== win.top && win.name === OFFICE_WINDOW_NAME
  );
}

/** Preserve Vite's deployment base while opening an internal application route. */
export function officeWindowHref(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Navigate to an external destination such as an OAuth provider's
 * authorization page. GitHub and Google send anti-framing headers, so loading
 * them inside the office's parchment iframe yields "refused to connect".
 * From that frame we escape to the top-level browsing context; everywhere
 * else this is a plain same-window navigation.
 */
export function navigateToExternal(
  url: string,
  win: OfficeFrameWindow | undefined = defaultWindow(),
): void {
  if (!win) return;
  if (isOfficeWindowFrame(win) && win.top) {
    try {
      // Assigning `href` (not calling `assign`) stays within the
      // cross-origin-safe subset of Location, in case the office page is
      // itself embedded somewhere and `top` belongs to another origin.
      win.top.location.href = url;
      return;
    } catch {
      // The top window refused the navigation (e.g. a sandboxed embedder).
      // Fall back to this frame so the user still reaches the provider.
    }
  }
  win.location.assign(url);
}
