const inFlight = new Map<string, Set<AbortController>>();

export function registerProactiveTalk(
  workspaceId: string,
  controller: AbortController,
): () => void {
  const controllers = inFlight.get(workspaceId) ?? new Set<AbortController>();
  controllers.add(controller);
  inFlight.set(workspaceId, controllers);
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) inFlight.delete(workspaceId);
  };
}

export function abortProactiveTalk(workspaceId: string): number {
  const controllers = inFlight.get(workspaceId);
  if (!controllers) return 0;
  for (const controller of controllers) controller.abort("emergency_stop");
  return controllers.size;
}
