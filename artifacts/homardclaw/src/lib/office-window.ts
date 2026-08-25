export const OFFICE_WINDOW_NAME = "homardclaw-office-window";

/** True inside the desktop office's same-origin parchment iframe. */
export function isOfficeWindowFrame(): boolean {
  return (
    typeof window !== "undefined" &&
    window.self !== window.top &&
    window.name === OFFICE_WINDOW_NAME
  );
}

/** Preserve Vite's deployment base while opening an internal application route. */
export function officeWindowHref(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
