import { ApiError } from "@workspace/api-client-react";

/**
 * Turn any error thrown by the generated API client into a message worth
 * showing in a toast.
 *
 * The generated client (`customFetch`) throws:
 * - `ApiError` for any non-2xx HTTP response, with the parsed body on
 *   `error.data` (our API always answers `{ error: string }`);
 * - the native fetch error (usually a `TypeError`) when no HTTP response
 *   arrived at all — connection drop, DNS failure, or a request the
 *   deployment proxy killed without answering.
 *
 * NOTE: an older axios-style `error.response.data.error` read silently
 * matched nothing against this client, so every server error collapsed to
 * the generic fallback. Read `error.data` — never `error.response.data`.
 */

/** Shown when the request never produced an HTTP response at all. */
export const NETWORK_ERROR_MESSAGE =
  "No response arrived — the connection dropped or the request timed out. " +
  "The work may still have finished; check the list, then try again.";

/**
 * Shown when a gateway/proxy answered instead of the API (deployment
 * timeout or restart), so there is no JSON `{ error }` body to surface.
 */
export const GATEWAY_ERROR_MESSAGE =
  "The server took too long to answer or is briefly unavailable. " +
  "Wait a moment and try again.";

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    // Our API's own errors always carry `{ error: string }` — surface that
    // actionable message verbatim.
    const data: unknown = error.data;
    if (data !== null && typeof data === "object") {
      const detail = (data as { error?: unknown }).error;
      if (typeof detail === "string" && detail.trim() !== "") {
        return detail;
      }
    }
    // A 502/503/504 without our JSON body came from the deployment proxy,
    // not the API (its body is HTML or empty) — never show that raw body.
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return GATEWAY_ERROR_MESSAGE;
    }
    return `The server rejected the request (HTTP ${error.status}). ${fallback}`;
  }
  // No HTTP response at all: fetch rejects with a TypeError (or an abort).
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return NETWORK_ERROR_MESSAGE;
  }
  return fallback;
}
