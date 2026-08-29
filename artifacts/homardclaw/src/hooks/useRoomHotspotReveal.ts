import React from "react";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * Point-and-click discovery mode. Holding Space reveals every element marked
 * with `data-room-hotspot` without stealing Space from forms or dialogs.
 */
export function useRoomHotspotReveal(disabled = false): boolean {
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    if (disabled) {
      setRevealed(false);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      event.preventDefault();
      setRevealed(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setRevealed(false);
    };
    const clear = () => setRevealed(false);

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clear);
    };
  }, [disabled]);

  return revealed;
}
