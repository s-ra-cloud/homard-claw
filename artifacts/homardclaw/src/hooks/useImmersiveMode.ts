import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

const IDLE_MS = 120_000; // 2 minutes

// Events that reset the idle countdown (before immersive mode kicks in).
// We intentionally list keydown here so any typing resets the timer;
// Escape is handled separately to exit immersive mode.
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "click",
  "touchstart",
  "touchmove",
  "wheel",
  "keydown",
] as const;

/**
 * Returns `true` when the scene should enter immersive (full-viewport) mode.
 *
 * - Activates automatically after IDLE_MS of inactivity.
 * - Exits ONLY when the user presses Escape.
 * - Pointer/touch/wheel/key activity (other than Escape while immersive)
 *   resets the countdown but does NOT dismiss immersive mode once entered.
 * - Route changes clear timers and reset the state.
 */
export function useImmersiveMode(): boolean {
  const [immersive, setImmersive] = useState(false);
  const [location] = useLocation();

  // Keep mutable state in a single ref to avoid stale closures in event handlers.
  const stateRef = useRef<{
    immersive: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    arm: () => void;
  }>({
    immersive: false,
    timer: null,
    arm: () => {},
  });

  useEffect(() => {
    const s = stateRef.current;

    function arm() {
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        s.immersive = true;
        setImmersive(true);
      }, IDLE_MS);
    }

    // Expose arm so the location effect can call it without re-running this effect.
    s.arm = arm;

    // Pre-immersive: any activity resets the idle countdown.
    function onActivity() {
      if (s.immersive) return; // ignore all input while immersive
      arm();
    }

    // Escape is the only exit from immersive mode; capture phase fires before
    // Shell's own keydown handler (which handles the mobile nav drawer).
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || !s.immersive) return;
      e.stopPropagation();
      s.immersive = false;
      setImmersive(false);
      arm(); // restart the countdown after exiting
    }

    arm(); // start countdown immediately on mount

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }
    window.addEventListener("keydown", onEscape, { capture: true });

    return () => {
      if (s.timer !== null) clearTimeout(s.timer);
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
      window.removeEventListener("keydown", onEscape, { capture: true });
    };
  }, []); // runs once on mount; cleanup on unmount

  // Route navigation: exit immersive, clear timers, restart countdown.
  useEffect(() => {
    const s = stateRef.current;
    if (s.timer !== null) clearTimeout(s.timer);
    s.immersive = false;
    setImmersive(false);
    s.arm();
  }, [location]);

  return immersive;
}
