/**
 * Per-request workspace identity, set by the requireWorkspace middleware.
 * Declared on the global Express namespace so every route file sees it
 * regardless of which express type package instance it resolves.
 */
declare namespace Express {
  interface Request {
    workspaceId?: string;
    workspaceUserId?: string;
  }
}
