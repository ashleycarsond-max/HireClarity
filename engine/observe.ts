/**
 * The observation pipeline — the heart of the engine. Given a posting URL:
 *
 *   robots check → polite fetch → extract → classify (live/removed) →
 *   dedupe/merge by postingId → relist detection → persist + events.
 *
 * Both `bun run track` (new URLs) and `bun run recheck` (existing URLs) call
 * this same function, so the classification logic is identical everywhere.
 */

import { createHash } from "node:crypto";
import { extractFromHtml, extractFromJson, looksLikeJson } from "./extract";
import { extractPayFromBody } from "./pay";
import { politeFetch } from "./fetch";
import { checkAllowed, hostOf, throttle } from "./robots";
import { Store } from "./store";
import type { ObserveResult, PostingRecord } from "./types";
import { derivePostingId, detectBoard, identityKey, normalizeUrl } from "./urls";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Content fingerprint for change detection: title + first chars of body text. */
function fingerprintOf(title: string | null, body: string | null): string | null {
  const text = stripTags(body ?? "").slice(0, 12000);
  return sha1(`${title ?? ""} ||| ${text}`);
}

export interface ObserveOptions {
  store: Store;
  /** Treat a fresh observation of an already-tracked URL as a "recheck" (status may flip). */
  isRecheck?: boolean;
  /** Skip robots.txt enforcement (used by tests/fixture only; default false). */
  skipRobots?: boolean;
  minIntervalMs?: number;
  now?: Date;
}

export async function observeUrl(inputUrl: string, opts: ObserveOptions): Promise<ObserveResult> {
  const store = opts.store;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // 1. Normalize the input URL so we can look up an existing record.
  const inputNorm = normalizeUrl(inputUrl);
  if (!inputNorm) {
    return { ok: false, postingId: null, canonicalUrl: null, transition: "error", status: "error", statusCode: null, note: `could not parse URL: ${inputUrl}` };
  }
  const inputPostingId = derivePostingId(inputNorm);
  let record = await store.getByPostingId(inputPostingId);

  // 2. Robots.txt check.
  if (!opts.skipRobots) {
    const { allowed, note, crawlDelay } = await checkAllowed(inputUrl);
    if (!allowed) {
      const msg = `blocked by robots.txt (${inputUrl}); not fetched`;
      if (record) {
        await store.addCheck(inputPostingId, nowIso, "blocked_by_robots", null, msg);
      }
      return { ok: false, postingId: inputPostingId, canonicalUrl: record?.canonicalUrl ?? inputNorm, transition: "blocked_by_robots", status: "blocked_by_robots", statusCode: null, note: msg + (note ? ` (${note})` : "") };
    }
    await throttle(hostOf(inputUrl), crawlDelay, opts.minIntervalMs ?? 2000);
  }

  // 3. Fetch.
  const res = await politeFetch(inputUrl);
  if (!res.ok && res.status === null) {
    // Network-level failure (timeout, DNS, TLS) — record honestly, don't guess.
    if (record) {
      await store.addCheck(inputPostingId, nowIso, "error", null, res.note);
    }
    return { ok: false, postingId: inputPostingId, canonicalUrl: record?.canonicalUrl ?? inputNorm, transition: "error", status: "error", statusCode: null, note: res.note ?? "fetch error" };
  }

  const finalUrl = res.finalUrl ?? inputNorm;
  const canonical = normalizeUrl(finalUrl) ?? inputNorm;
  const postingId = derivePostingId(canonical);
  record = (await store.getByPostingId(postingId)) ?? record;

  const statusCode = res.status ?? 0;
  const body = res.body ?? "";

  // 4. Classify the observation.
  let removed = false;
  let removeReason: string | null = null;
  let extracted: ReturnType<typeof extractFromHtml> | null = null;

  if (statusCode >= 400) {
    removed = true;
    removeReason = `HTTP ${statusCode}`;
  } else if (looksLikeJson(res.contentType, body)) {
    extracted = extractFromJson(body, finalUrl);
    if (extracted?.notFound) {
      removed = true;
      removeReason = extracted.notFoundReason ?? "API marks posting as gone";
    }
  } else {
    extracted = extractFromHtml(body, finalUrl);
    if (extracted.notFound) {
      removed = true;
      removeReason = extracted.notFoundReason ?? "page content indicates the posting is gone";
    }
  }

  // 5. Merge extracted fields.
  const title = extracted?.title ?? null;
  const company = extracted?.company ?? null;
  const location = extracted?.location ?? null;
  const postedAt = extracted?.postedAt ?? null;
  const sourceBoard = extracted?.sourceBoard ?? detectBoard(canonical);
  const fingerprint = fingerprintOf(title, body);

  // Identity: normalized title+company; fall back to the postingId when either
  // is missing (we cannot honestly claim two postings are "the same role" from
  // content alone if we never saw a title/company). If we already have a
  // content-based identity for this posting and this observation can't extract
  // one (e.g. a 404 page), keep the existing identity so events stay consistent.
  let idKey = identityKey(title, company);
  if (!idKey) idKey = record && record.identityKey !== record.postingId ? record.identityKey : postingId;

  // 6. Relist detection — identity reappears after a removal.
  let relistFrom: PostingRecord | null = null;
  if (!removed && !record) {
    const candidates = (await store.getByIdentity(idKey)).filter((r) => r.status === "removed" && r.postingId !== postingId);
    if (candidates.length) {
      // Most recent removal first (getByIdentity orders by first_seen; pick by lastSeen).
      candidates.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
      relistFrom = candidates[0];
    }
  }

  // 7. Persist.
  const isNew = !record;
  const wasRemoved = record?.status === "removed";
  let status: PostingRecord["status"];
  let relistCount = record?.relistCount ?? 0;
  let transition: ObserveResult["transition"] = "no_change";
  let note: string | null = null;

  if (removed) {
    status = "removed";
    transition = wasRemoved || isNew ? (isNew ? "first_seen" : "no_change") : "removed";
    note = removeReason ?? "posting gone";
  } else {
    if (isNew) {
      status = relistFrom ? "relisted" : "live";
      transition = "first_seen";
      note = relistFrom ? `relisted: reappeared at ${canonical} after removal of ${relistFrom.postingId}` : "first observation";
    } else if (wasRemoved) {
      status = "relisted";
      relistCount += 1;
      transition = "relisted";
      note = `reappeared at ${canonical} after being observed removed (${record!.lastNote ?? "unknown reason"})`;
    } else {
      status = record!.status === "relisted" ? "relisted" : "live";
      transition = "still_live";
      note = null;
    }
  }

  if (relistFrom && isNew && !removed) {
    relistCount = relistFrom.relistCount + 1;
  }

  const merged: PostingRecord = {
    postingId,
    canonicalUrl: canonical,
    requestedUrl: record?.requestedUrl ?? inputNorm,
    title: title ?? record?.title ?? null,
    company: company ?? record?.company ?? null,
    location: location ?? record?.location ?? null,
    postedAt: postedAt ?? record?.postedAt ?? null,
    sourceBoard: sourceBoard || record?.sourceBoard || "web",
    identityKey: idKey,
    fingerprint,
    status,
    relistCount,
    firstSeenAt: record?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    lastCheckedAt: nowIso,
    lastStatusCode: statusCode,
    lastNote: note ?? (removed ? removeReason : `live (HTTP ${statusCode})`),
    createdAt: record?.createdAt ?? nowIso,
  };
  await store.upsertPosting(merged);

  // 8. Pay extraction (owner decision 2026-08-15): read compensation from the
  //    page body we already fetched — structured ATS/JSON-LD fields first, then
  //    the visible description text. A reading that finds no pay records the
  //    honest "not stated" row; the store's monotone merge never downgrades a
  //    positive observation made earlier.
  if (!removed && body) {
    const payExtract = extractPayFromBody(body, res.contentType);
    await store.upsertPay({
      postingId,
      hasPay: Boolean(payExtract),
      payMin: payExtract?.min ?? null,
      payMax: payExtract?.max ?? null,
      currency: payExtract?.currency ?? null,
      period: payExtract?.period ?? null,
      payText: payExtract?.payText ?? null,
      source: payExtract?.source ?? null,
      fetchError: null,
      extractedAt: nowIso,
    });
  }

  // 9. Checks + events (append-only, chronological, no fabrication).
  await store.addCheck(postingId, nowIso, removed ? "removed" : status, statusCode, note ?? null);

  if (isNew) {
    await store.addEvent({ postingId, identityKey: idKey, type: "first_seen", at: nowIso, detail: `tracked from ${inputNorm} → canonical ${canonical}` });
    if (removed) {
      await store.addEvent({ postingId, identityKey: idKey, type: "removed", at: nowIso, detail: removeReason ?? "gone on first observation" });
    }
    if (relistFrom) {
      await store.addEvent({ postingId, identityKey: idKey, type: "relisted", at: nowIso, detail: `reappeared after removal of ${relistFrom.postingId} (was listed from ${relistFrom.firstSeenAt} to ${relistFrom.lastSeenAt})` });
    }
  } else if (transition === "removed") {
    await store.addEvent({ postingId, identityKey: idKey, type: "removed", at: nowIso, detail: removeReason ?? "HTTP gone" });
  } else if (transition === "relisted") {
    await store.addEvent({ postingId, identityKey: idKey, type: "relisted", at: nowIso, detail: `reappeared at ${canonical} after removal (relist #${relistCount})` });
  } else if (transition === "still_live") {
    // Only record still_live when content actually changed or periodically — v1:
    // record it when the page's identity fields changed vs. what we stored.
    const titleChanged = title && record!.title && title !== record!.title;
    const companyChanged = company && record!.company && company !== record!.company;
    if (titleChanged || companyChanged) {
      await store.addEvent({ postingId, identityKey: idKey, type: "content_changed", at: nowIso, detail: `title/company changed: "${record!.title}" → "${title}"` });
    }
  }

  return {
    ok: true,
    postingId,
    canonicalUrl: canonical,
    transition,
    status,
    statusCode,
    note: note ?? (removed ? removeReason : `live (HTTP ${statusCode})`),
  };
}
