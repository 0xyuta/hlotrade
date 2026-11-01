export type Entry = { page: "app" } | { page: "pair"; legacyLink: boolean };

/**
 * Called once in main.tsx, before React renders. /pair is the phone's pairing page. An old `/pair#<key>` link (Plan 3)
 * has its fragment dropped from the address bar here, unread: no code decodes or stores a key from a URL any more.
 * The browser's history may still list the old link; the page tells the user it is no longer used.
 */
export function takeEntry(w: { location: Pick<Location, "pathname" | "hash">; history: Pick<History, "replaceState"> }): Entry {
  if (w.location.pathname !== "/pair") return { page: "app" };
  const legacyLink = w.location.hash.length > 1;
  if (w.location.hash) w.history.replaceState(null, "", "/pair");
  return { page: "pair", legacyLink };
}
