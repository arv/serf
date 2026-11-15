/**
 * Where an address is, roughly: the city, region and country a bundled
 * database (geoip-lite, MaxMind's GeoLite data) puts it in.
 *
 * Offline on purpose. The address belongs to a player who was never asked,
 * and the one thing worse than keeping it would be handing it to somebody
 * else's lookup service to learn a city. Here the address goes in, a place
 * name comes out, and nothing leaves the process.
 *
 * The database is some hundred megabytes resident once loaded, so it is
 * loaded on the first lookup rather than at import: the test suite and any
 * server that never files a replay do not pay for it.
 *
 * Accuracy is what a free database gives — the country is dependable, the
 * city is a good guess, and an address behind a VPN or a mobile carrier is
 * wherever the exit happens to be. City and region are IPv4 only; an IPv6
 * address gets its country and nothing finer.
 */

/** A place, as coarse as the database had it. Country is always there —
 * a lookup that cannot name one is no location at all. */
export interface GeoLocation {
  /** ISO 3166-1 alpha-2, e.g. `SE`. */
  country: string;
  /** ISO 3166-2 subdivision without the country prefix, e.g. `O`. */
  region?: string;
  city?: string;
}

export type GeoLookup = (ip: string) => GeoLocation | null;

let lookup: GeoLookup | null = null;

async function bundledLookup(): Promise<GeoLookup> {
  const {default: geoip} = await import('geoip-lite');
  return ip => {
    const hit = geoip.lookup(ip);
    if (hit === null || !hit.country) return null;
    return {
      country: hit.country,
      ...(hit.region ? {region: hit.region} : {}),
      ...(hit.city ? {city: hit.city} : {}),
    };
  };
}

/**
 * The place an address is in, or null when the database does not know —
 * loopback, a private range, `unknown`, or simply an unlisted block.
 *
 * Never throws: a location is a column on a listing, and a database that
 * failed to load must not cost the recording it would have decorated.
 */
export async function locateIp(ip: string): Promise<GeoLocation | null> {
  try {
    lookup ??= await bundledLookup();
    // A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`; the
    // bare form is the one the city-level table is keyed on.
    return lookup(ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ''));
  } catch {
    return null;
  }
}

/**
 * A header value as the text it was sent as. Node reads header bytes as
 * Latin-1, and Cloudflare sends place names in UTF-8, so a city like
 * Jönköping arrives as mojibake unless the bytes are read again.
 */
function utf8Header(raw: string): string {
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? raw : decoded;
}

/**
 * The place Cloudflare says the visitor is in, from the headers it adds
 * to a request it proxied, or null when it said nothing usable.
 *
 * CF-IPCountry is on by default; the city and region come only with the
 * "Add visitor location headers" managed transform switched on for the
 * zone. Cloudflare's data is current and covers IPv6, neither of which
 * the bundled database can claim, so where it speaks it is preferred.
 *
 * Only call this for a request known to have come through Cloudflare
 * (log.ts, cameThroughCloudflare): on any other the headers are the
 * caller's own.
 */
export function cloudflareLocation(
  headers: Record<string, string | string[] | undefined>,
): GeoLocation | null {
  const one = (name: string): string | undefined => {
    const raw = headers[name];
    if (typeof raw !== 'string') return undefined;
    const value = utf8Header(raw).trim();
    return value.length > 0 ? value : undefined;
  };
  const country = one('cf-ipcountry')?.toUpperCase();
  // XX is "unknown" and T1 is Tor: neither is a place.
  if (country === undefined || !/^[A-Z]{2}$/.test(country)) return null;
  if (country === 'XX' || country === 'T1') return null;
  const region = one('cf-region-code');
  const city = one('cf-ipcity');
  return {
    country,
    ...(region !== undefined ? {region} : {}),
    ...(city !== undefined ? {city} : {}),
  };
}

/**
 * Where an upload came from, by the better of the two sources.
 *
 * Cloudflare's answer when it gave a city. When it named only a country,
 * the database's city is kept if it agrees on that country, and dropped
 * if it does not — a city in the wrong country is worse than none. With
 * nothing from Cloudflare, the database alone.
 */
export async function locate(
  ip: string,
  edge: GeoLocation | null,
): Promise<GeoLocation | null> {
  if (edge?.city !== undefined) return edge;
  const guess = await locateIp(ip);
  if (edge === null) return guess;
  return guess?.country === edge.country ? {...guess, ...edge} : edge;
}

/** Test seam: answer lookups from this instead of the bundled database,
 * or pass null to go back to it. */
export function setGeoLookup(next: GeoLookup | null): void {
  lookup = next;
}
