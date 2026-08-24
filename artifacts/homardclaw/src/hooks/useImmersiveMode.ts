import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

const IDLE_MS = 2 * 60 * 1000; // 2 minutes of no mouse/keyboard activity

/**
 * Returns the current immersive state and a function to enter immersive mode.
 *
 * - Auto-entry: after 2 minutes of inactivity, the scene fills the viewport.
 * - Manual-entry: call `enterImmersive()` from the navigation menu immediately.
 * - Exit via Escape key (capture phase, so it fires before other handlers).
 * - Any mouse or keyboard activity while not immersive resets the idle timer.
 * - Route changes always exit immersive mode and reset state.
 */
export function useImmersiveMode(): { immersive: boolean; enterImmersive: () => void } {
  const [immersive, setImmersive] = useState(false);
  const [location] = useLocation();

  // Keep mutable flag in a ref so the Escape handler never closes over stale state.
  const immersiveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enter = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    immersiveRef.current = true;
    setImmersive(true);
  }, []);

  const enterImmersive = useCallback(() => {
    enter();
  }, [enter]);

  const scheduleAutoEntry = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!immersiveRef.current) enter();
    }, IDLE_MS);
  }, [enter]);

  // Start and reset the idle timer on activity.
  useEffect(() => {
    scheduleAutoEntry();

    const onActivity = () => {
      if (!immersiveRef.current) scheduleAutoEntry();
    };

    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("mousedown", onActivity, { passive: true });
    window.addEventListener("click", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true, capture: false });
    window.addEventListener("wheel", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("touchmove", onActivity, { passive: true });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("mousedown", onActivity);
      window.removeEventListener("click", onActivity);
      window.removeEventListener("keydown", onActivity, { capture: false } as EventListenerOptions);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("touchmove", onActivity);
    };
  }, [scheduleAutoEntry]);

  // Escape is the only exit from immersive mode; capture phase fires before
  // Shell's own keydown handler (which handles the mobile nav drawer).
  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || !immersiveRef.current) return;
      e.stopPropagation();
      immersiveRef.current = false;
      setImmersive(false);
      // Restart the idle timer so the scene can re-enter immersive after
      // the user walks away again.
      scheduleAutoEntry();
    }

    window.addEventListener("keydown", onEscape, { capture: true });
    return () => {
      window.removeEventListener("keydown", onEscape, { capture: true });
    };
  }, [scheduleAutoEntry]);

  // Route navigation: exit immersive and reset state.
  useEffect(() => {
    immersiveRef.current = false;
    setImmersive(false);
    scheduleAutoEntry();
  }, [location]); // eslint-disable-line react-hooks/exhaustive-deps

  return { immersive, enterImmersive };
}
