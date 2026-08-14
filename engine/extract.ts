/**
 * Extract posting metadata (title, company, location, posted date) from
 * fetched content. Works on both HTML posting pages and JSON job-board API
 * payloads. All extraction is heuristic but conservative: if a field can't be
 * found, it stays null — we never guess values we didn't observe.
 */

import type { ExtractedPosting } from "./types";
import { detectBoard } from "./urls";

const NOT_FOUND_TITLE =
  /(page\s+)?not\s+found|no\s+longer\s+(available|accepting)|position\s+(has\s+been\s+)?(filled|closed)|job\s+(has\s+been\s+)?removed|does\s+not\s+exist|vacancy\s+does\s+not\s+exist|sorry,?\s+this\s+(job|position)/i;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && (item as { "@type"?: string })["@type"] === "JobPosting") return item as Record<string, unknown>;
        }
        continue;
      }
      if (parsed && typeof parsed === "object" && (parsed as { "@type"?: string })["@type"] === "JobPosting") return parsed as Record<string, unknown>;
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

function metaContent(html: string, prop: string): string | null {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
  return m ? m[1].trim() : null;
}

function h1Text(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
}

/** Location heuristic for Greenhouse-style boards: text inside .job__location. */
function jobLocationClass(html: string): string | null {
  // Match the element's opening tag, then take everything up to the first
  // closing </div> (Greenhouse nests the text: <div class="job__location"><div>Ontario</div></div>).
  const m = html.match(/class=["'][^"']*\bjob__location\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return null;
  let seg = m[1].replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  // If the text sits in a nested div, prefer that inner content.
  const inner = seg.match(/<div[^>]*>([\s\S]*?)<\/div>/i);
  const text = stripTags(inner ? inner[1] : seg).trim();
  return text.slice(0, 80) || null;
}

function locationFromJsonLd(j: Record<string, unknown>): string | null {
  const loc = j["jobLocation"];
  if (Array.isArray(loc) && loc.length) {
    return loc.map((l) => locationFromJsonLd(l as Record<string, unknown>)).filter(Boolean).join(", ") || null;
  }
  if (!loc || typeof loc !== "object") return null;
  const l = loc as Record<string, unknown>;
  if (typeof l["name"] === "string") return l["name"];
  const addr = l["address"] as Record<string, unknown> | undefined;
  if (addr && typeof addr === "object") {
    const parts = [addr["addressLocality"], addr["addressRegion"], addr["addressCountry"]]
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (parts.length) return parts.join(", ");
  }
  return null;
}

function companyFromJsonLd(j: Record<string, unknown>): string | null {
  const org = j["hiringOrganization"];
  if (!org || typeof org !== "object") return null;
  const name = (org as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length ? name : null;
}

/** Parse <title> patterns: "Job Application for X at Y", "X @ Y", "X at Y". */
function parseTitleTag(titleTag: string): { title: string | null; company: string | null } {
  let t = stripTags(titleTag);
  if (!t) return { title: null, company: null };
  let m = t.match(/^Job Application for (.+?) at (.+)$/i);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = t.match(/^(.+?) @ (.+)$/);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = t.match(/^(.+?) at (.+)$/i);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  return { title: t, company: null };
}

export function extractFromHtml(html: string, finalUrl: string): ExtractedPosting {
  const board = detectBoard(finalUrl);
  const ld = firstJsonLd(html);
  const ogTitle = metaContent(html, "og:title");
  const ogSiteName = metaContent(html, "og:site_name");
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const parsedTitle = parseTitleTag(titleTag ?? "");

  const title =
    (ld && typeof ld["title"] === "string" && ld["title"]) ||
    ogTitle ||
    parsedTitle.title ||
    h1Text(html) ||
    null;

  const company =
    (ld && companyFromJsonLd(ld)) ||
    ogSiteName ||
    parsedTitle.company ||
    null;

  const location =
    (ld && locationFromJsonLd(ld)) ||
    jobLocationClass(html) ||
    null;

  let postedAt: string | null = null;
  if (ld) {
    const dp = ld["datePosted"];
    if (typeof dp === "string") postedAt = dp;
  }
  if (!postedAt) {
    const m = metaContent(html, "datePosted") || metaContent(html, "article:published_time");
    if (m) postedAt = m;
  }
  // Normalize a bare YYYY-MM-DD to a full ISO instant so consumers get a consistent shape.
  if (postedAt && /^\d{4}-\d{2}-\d{2}$/.test(postedAt)) postedAt = `${postedAt}T00:00:00Z`;

  const notFound = (() => {
    const candidates = [titleTag, ogTitle, h1Text(html)].filter((c): c is string => !!c);
    for (const c of candidates) {
      if (NOT_FOUND_TITLE.test(c)) return true;
    }
    // Some boards return 200 with a generic error page — check the first body text too.
    const bodyStart = stripTags(html).slice(0, 600);
    if (/page (was )?not found|job (has been )?removed|no longer accepting applications/i.test(bodyStart)) return true;
    return false;
  })();

  return {
    title: title && title.length <= 300 ? title : null,
    company: company && company.length <= 200 ? company : null,
    location: location && location.length <= 200 ? location : null,
    postedAt,
    sourceBoard: board,
    canonicalUrl: null,
    notFound,
    notFoundReason: notFound ? "page content indicates the posting is gone" : null,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Parse a JSON job-board payload. Recognizes the public, fetchable ATS APIs
 * (Greenhouse boards API, Ashby posting-api, Lever postings API) plus plain
 * single-job objects. Returns the first listed job.
 */
export function extractFromJson(body: string, finalUrl: string): ExtractedPosting | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const board = detectBoard(finalUrl);

  const pickJob = (j: Record<string, unknown>): ExtractedPosting | null => {
    if (!j || typeof j !== "object") return null;
    const title = str(j["title"]) ?? str(j["text"]) ?? null;
    let location: string | null = null;
    const loc = j["location"];
    if (typeof loc === "string") location = loc;
    else if (loc && typeof loc === "object") location = str((loc as Record<string, unknown>)["name"]);
    if (!location) {
      const cats = j["categories"] as Record<string, unknown> | undefined;
      if (cats && typeof cats === "object") location = str(cats["location"]);
    }
    const postedAt = str(j["posted_at"]) ?? str(j["publishedAt"]) ?? str(j["createdAt"]) ?? str(j["updated_at"]);
    const canonicalUrl = str(j["absolute_url"]) ?? str(j["hostedUrl"]) ?? str(j["jobUrl"]) ?? null;
    const isListed = j["isListed"] !== false;
    return {
      title,
      company: str(j["company"]) ?? str(j["organizationName"]) ?? null,
      location,
      postedAt,
      sourceBoard: board,
      canonicalUrl,
      notFound: !isListed,
      notFoundReason: !isListed ? "board API marks the posting as not listed" : null,
    };
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      const p = pickJob(item as Record<string, unknown>);
      if (p && (p.title || p.canonicalUrl)) return p;
    }
    return null;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (obj["ok"] === false) return null; // API error envelope
    if (Array.isArray(obj["jobs"])) {
      for (const item of obj["jobs"] as unknown[]) {
        const p = pickJob(item as Record<string, unknown>);
        if (p && (p.title || p.canonicalUrl)) return p;
      }
      return null;
    }
    if (obj["@type"] === "JobPosting") {
      const ld = obj as Record<string, unknown>;
      return {
        title: str(ld["title"]),
        company: companyFromJsonLd(ld),
        location: locationFromJsonLd(ld),
        postedAt: str(ld["datePosted"]),
        sourceBoard: board,
        canonicalUrl: null,
        notFound: false,
        notFoundReason: null,
      };
    }
    const p = pickJob(obj);
    if (p && (p.title || p.canonicalUrl)) return p;
  }
  return null;
}

export function looksLikeJson(contentType: string | null, body: string | null): boolean {
  if (!body) return false;
  if (contentType && /json/i.test(contentType)) return true;
  const t = body.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}
