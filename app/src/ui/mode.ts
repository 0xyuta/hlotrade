/** Which app the user has switched to: the full one, or the simple mine screen. Kept in browser storage. */
export type AppMode = "full" | "mine";
export const MODE_KEY = "hlo:mode";
export const parseMode = (v: string | null): AppMode => (v === "mine" ? "mine" : "full");
