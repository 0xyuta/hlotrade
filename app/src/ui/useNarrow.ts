import { useSyncExternalStore } from "react";

/** Where the app turns into its phone layout; the same width as the phone rules in styles.css. */
const NARROW = "(max-width: 860px)";

const media = () => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null);

/** True on a phone or small tablet. Follows a rotation or a window resize. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const m = media();
      m?.addEventListener("change", changed);
      return () => m?.removeEventListener("change", changed);
    },
    () => media()?.matches ?? false,
  );
}
