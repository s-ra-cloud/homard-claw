import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

/**
 * Returns the current immersive state and a function to enter immersive mode.
 *
 * - Entry is explicit: call `enterImmersive()` from the navigation menu.
 * - Exit via Escape key (capture phase, so it fires before other handlers).
 * - Route changes always exit immersive mode and reset state.
 */
export function useImmersiveMode(): { immersive: boolean; enterImmersive: () => void } {
  const [immersive, setImmersive] = useState(false);
  const [location] = useLocation();

  // Keep mutable flag in a ref so the Escape handler never closes over stale state.
  const immersiveRef = useRef(false);

  const enterImmersive = useCallback(() => {
    immersiveRef.current = true;
    setImmersive(true);
  }, []);

  useEffect(() => {
    // Escape is the only exit from immersive mode; capture phase fires before
    // Shell's own keydown handler (which handles the mobile nav drawer).
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || !immersiveRef.current) return;
      e.stopPropagation();
      immersiveRef.current = false;
      setImmersive(false);
    }

    window.addEventListener("keydown", onEscape, { capture: true });
    return () => {
      window.removeEventListener("keydown", onEscape, { capture: true });
    };
  }, []); // runs once on mount; cleanup on unmount

  // Route navigation: exit immersive and reset state.
  useEffect(() => {
    immersiveRef.current = false;
    setImmersive(false);
  }, [location]);

  return { immersive, enterImmersive };
}
