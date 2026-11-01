/** The parts of Cloudflare's Workers runtime this Worker uses (bindings from wrangler.jsonc). Tests pass fakes. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

/** The R2 binding's methods we call: head (null when absent) and put (with `onlyIf`, null when the precondition fails). */
export interface RegistryBucket {
  head(key: string): Promise<object | null>;
  put(key: string, value: string, options: { onlyIf?: Headers; httpMetadata: { contentType: string } }): Promise<object | null>;
}

export interface Env {
  ASSETS: AssetsFetcher;
  REGISTRY: RegistryBucket;
  /** "testnet" or "mainnet" (wrangler.jsonc vars); anything else makes /api/register answer 503. */
  HLO_NETWORK?: string;
}

/** request.cf fields the country block reads (ISO 3166-1 country, ISO 3166-2 subdivision code without the country). */
export interface Cf {
  country?: string | null;
  regionCode?: string | null;
}
