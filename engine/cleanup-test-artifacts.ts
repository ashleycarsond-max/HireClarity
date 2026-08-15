/**
 * ONE-OFF test-artifact cleanup.
 *
 * 1. (2026-08-14) Remove the single removed test-artifact posting whose
 *    canonical URL is `boards.greenhouse.io/notion?error=true` (null title,
 *    null company, created 2026-08-13T20:38 during check-tool error-path
 *    testing). That posting makes buildRegistry auto-discover a phantom
 *    greenhouse/notion board ref on the Notion registry entry, which then
 *    honestly 404s on every sync run. Deleting the artifact restores a clean
 *    sync cycle. No real data is touched — only postings with status=removed,
 *    null title and null company.
 *
 * 2. (2026-08-15) Purge the TestCo/acme fixture postings — real-shaped
 *    fixtures written into the LIVE store by engine/watchlist-test.ts and
 *    friends (company "TestCo", canonical URLs under
 *    boards.greenhouse.io/acme/jobs/fx-…/test-watch-…). They auto-discovered
 *    the phantom "TestCo [greenhouse]" registry entry that 404s on every sync
 *    cycle (same bug class as the notion?error=true phantom). All are pure
 *    fixtures: company TestCo + /acme/ URL + the fx-/test-watch- posting
 *    markers. buildRegistry's TEST_ARTIFACT denylist (2026-08-15) prevents
 *    re-pollution; this run removes what already leaked. No real data is
 *    touched — no real company is named TestCo on an acme Greenhouse board.
 */
import { Store } from "./store";
import { isTestArtifactBoardId, isTestArtifactName } from "./companies";

const s = new Store();
const all = await s.getAll();
const targets = all.filter(
  (r) =>
    r.status === "removed" &&
    r.title === null &&
    r.company === null &&
    r.canonicalUrl !== null
);
console.log(`candidates (removed, null title/company): ${targets.length}`);
for (const r of targets) {
  console.log(`  ${r.postingId}  ${r.sourceBoard}  ${r.canonicalUrl}`);
}
for (const r of targets) {
  await s.deletePosting(r.postingId);
  console.log(`deleted ${r.postingId}`);
}

// TestCo/acme fixture purge (2026-08-15): any status — live fixtures exist too.
const fixtures = all.filter((r) => {
  if (!r.canonicalUrl) return false;
  if (r.company && isTestArtifactName(r.company)) return true;
  if (isTestArtifactBoardId(r.canonicalUrl)) return true; // acme board id in URL
  return false;
});
console.log(`\nTestCo/acme fixtures (company test-name or /acme/ board): ${fixtures.length}`);
for (const r of fixtures) {
  console.log(`  ${r.postingId}  ${r.sourceBoard}  ${r.company ?? "(no company)"}  ${r.canonicalUrl}`);
}
for (const r of fixtures) {
  await s.deletePosting(r.postingId);
  console.log(`deleted ${r.postingId}`);
}

const after = await s.getAll();
console.log(`postings after cleanup: ${after.length}`);
