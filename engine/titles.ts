/**
 * TITLE NORMALIZATION for the daily/monthly report's "most popular job titles".
 *
 * Philosophy (honesty first): we count EXACT normalized-title frequency. We do
 * NOT merge semantically-different roles ("senior software engineer" stays
 * distinct from "software engineer" — merging levels would invent a popularity
 * ranking the data doesn't support). Normalization only does things that are
 * plainly mechanical:
 *
 *   1. trim + collapse internal whitespace
 *   2. strip trailing LOCATION-ish tokens (documented, conservative — only
 *      tokens in the curated list below, or a "City, ST" state-code suffix,
 *      or remote/hybrid/onsite markers, are removed)
 *   3. lowercase
 *
 * Anything that is not plainly a location suffix stays in the title. False
 * negatives (an unknown city left in a title) are fine — that's honest. False
 * positives (merging two different roles into one bucket) are what we avoid.
 *
 * The deliberate non-grouping of seniority prefixes is documented here because
 * it is a decision, not an oversight:
 *   "senior software engineer"  -> "senior software engineer"  (kept as-is)
 *   "software engineer"         -> "software engineer"         (kept as-is)
 *   "staff software engineer"   -> "staff software engineer"   (kept as-is)
 * These are different roles for job seekers; merging them would overstate
 * "software engineer" counts.
 */

/** Curated location/region/market tokens that may be stripped from a title END.
 *  Lowercase; matched case-insensitively against the trailing phrase. */
export const LOCATION_HINTS = new Set([
  // work-mode markers
  "remote", "hybrid", "onsite", "on-site", "remote-first", "hybrid-remote", "in-office",
  // regions / markets (sales territory style)
  "emea", "apac", "latam", "anz", "dach", "cee", "mena", "amer", "amers", "namer",
  "east", "west", "north", "south", "central", "midwest", "southeast", "southwest",
  "northeast", "northwest", "north america", "south america", "north america west",
  "north america east", "central europe", "eastern europe", "western europe",
  "scandinavia", "nordics", "benelux", "uk & ireland", "uk and ireland", "uk/ireland",
  "asia pacific", "asia-pacific", "asia", "latin america", "southern europe",
  "international", "global", "worldwide", "europe", "united states", "usa", "us",
  "canada", "uk", "united kingdom", "new england", "california", "texas", "germany",
  "france", "spain", "italy", "netherlands", "poland", "sweden", "norway", "denmark",
  "finland", "ireland", "belgium", "switzerland", "austria", "portugal", "greece",
  "turkey", "israel", "uae", "saudi arabia", "qatar", "south africa", "nigeria",
  "kenya", "egypt", "mexico", "argentina", "chile", "colombia", "peru", "brazil",
  "australia", "new zealand", "japan", "korea", "south korea", "china", "taiwan",
  "hong kong", "singapore", "india", "indonesia", "vietnam", "thailand", "malaysia",
  "philippines", "czech republic", "romania", "hungary", "ukraine", "russia",
  // cities / metros (common in ATS titles)
  "new york", "new york city", "new york city metro", "nyc", "san francisco",
  "san francisco bay area", "sf bay area", "bay area", "palo alto", "mountain view",
  "menlo park", "redwood city", "sunnyvale", "santa clara", "cupertino", "oakland",
  "san jose", "los angeles", "seattle", "portland", "denver", "austin", "dallas",
  "houston", "chicago", "boston", "philadelphia", "washington dc", "washington, dc",
  "washington", "atlanta", "miami", "orlando", "detroit", "minneapolis", "st. louis",
  "pittsburgh", "raleigh", "charlotte", "nashville", "phoenix", "san diego",
  "salt lake city", "kansas city", "columbus", "cleveland", "cincinnati",
  "toronto", "vancouver", "montreal", "ottawa", "calgary", "waterloo",
  "london", "manchester", "birmingham", "leeds", "edinburgh", "glasgow", "dublin",
  "paris", "berlin", "munich", "hamburg", "frankfurt", "cologne", "stuttgart",
  "düsseldorf", "amsterdam", "rotterdam", "brussels", "antwerp", "zurich", "geneva",
  "vienna", "warsaw", "krakow", "wroclaw", "gdansk", "prague", "budapest",
  "bucharest", "stockholm", "copenhagen", "oslo", "helsinki", "madrid", "barcelona",
  "lisbon", "porto", "milan", "rome", "turin", "athens", "istanbul",
  "tel aviv", "jerusalem", "dubai", "abu dhabi", "johannesburg", "cape town",
  "lagos", "nairobi", "cairo", "mexico city", "buenos aires", "santiago", "bogota",
  "lima", "sao paulo", "rio de janeiro", "sydney", "melbourne", "brisbane", "perth",
  "adelaide", "auckland", "wellington", "tokyo", "osaka", "kyoto", "seoul", "beijing",
  "shanghai", "shenzhen", "hong kong", "taipei", "singapore", "bangkok", "jakarta",
  "manila", "ho chi minh city", "ho chi minh", "hanoi", "kuala lumpur", "mumbai",
  "bangalore", "bengaluru", "hyderabad", "delhi", "gurgaon", "pune", "chennai",
  "kolkata", "noida", "romeoville",
]);

/** US state codes (also treated as location when they end a title phrase). */
const STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt",
  "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
  "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);

/** Lowercase the phrase and check whether it looks like a location suffix. */
export function isLocationish(phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  if (LOCATION_HINTS.has(p)) return true;
  // "City, ST" — ends with a US state code
  if (/^[a-z][\w.'-]*(?:\s+[a-z][\w.'-]*)*,\s*[a-z]{2}$/.test(p)) {
    const st = p.slice(-2);
    if (STATE_CODES.has(st)) return true;
  }
  // "City, Country" where BOTH halves are known location hints
  const parts = p.split(",").map((x) => x.trim());
  if (parts.length === 2 && parts.every((x) => x && LOCATION_HINTS.has(x))) return true;
  return false;
}

const MAX_STRIP_PASSES = 4;

/** Strip trailing location-ish tokens (parenthesized, dashed, or comma-joined). */
export function stripTrailingLocationish(title: string): string {
  let t = title.trim();
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const before = t;
    // 1. trailing "(...)" / "[...]" group, when the inside is location-ish
    t = t.replace(/\s*[([][^)\]]*[)\]]$/, (m) => {
      const inner = m.replace(/[()\[\]]/g, "").trim();
      return isLocationish(inner) ? "" : m;
    });
    // 2. trailing "- X" / "| X" / "– X" / "— X" phrase, when location-ish
    t = t.replace(/\s*[-–—|]\s*([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*)$/, (m, phrase: string) =>
      isLocationish(phrase) ? "" : m
    );
    // 3. trailing ", X" / "; X" phrase, when location-ish — multi-word forms
    //    including "City, ST" ("Account Executive, Romeoville, IL")
    t = t.replace(/[,;]\s*([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*(?:,\s*[A-Z]{2})?)$/, (m, phrase: string) =>
      isLocationish(phrase) ? "" : m
    );
    // 4. trailing " - " + "City, ST" style (dash-joined full location phrase)
    t = t.replace(/\s*[-–—|]\s*([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*,\s*[A-Z]{2})$/, (m, phrase: string) =>
      isLocationish(phrase) ? "" : m
    );
    if (t === before) break;
    t = t.trim();
  }
  return t.trim();
}

/**
 * Normalize a posting title for frequency counting.
 * Returns "" for null/blank input (callers skip empty buckets).
 */
export function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = raw.trim();
  if (!t) return "";
  t = stripTrailingLocationish(t);
  t = t.toLowerCase();
  t = t.replace(/\s+/g, " ").trim();
  // trailing punctuation that is not part of the title ("Engineer." -> "Engineer")
  t = t.replace(/[.,;:!?]+$/, "").trim();
  return t;
}
