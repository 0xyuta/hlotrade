import type { Address } from "../config/validate";

const flagKey = (user: Address) => `hlo.registered.${user.toLowerCase()}`;

function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // blocked storage: register once per call instead
  }
}

/**
 * Tells our server this wallet has trading enabled, so its fills count for rewards from now on. Once per wallet per
 * browser session (the flag is set only on a 200). Never throws: a failure just means the next app open tries again.
 */
export async function registerWallet(user: Address, fetchFn: typeof fetch = fetch, storage: Storage | undefined = session()): Promise<void> {
  const key = flagKey(user);
  try {
    if (storage?.getItem(key)) return;
  } catch {
    // unreadable flag: post anyway
  }
  try {
    const r = await fetchFn("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: user.toLowerCase() }),
    });
    if (!r.ok) return;
    try {
      storage?.setItem(key, "1");
    } catch {
      // unwritable flag: the server treats a repeat as already registered
    }
  } catch {
    // offline or blocked: retried on the next open
  }
}
