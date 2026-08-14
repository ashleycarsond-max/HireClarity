/**
 * ONE-OFF cleanup (2026-08-14): remove the single removed test-artifact posting
 * whose canonical URL is `boards.greenhouse.io/notion?error=true` (null title,
 * null company, created 2026-08-13T20:38 during check-tool error-path testing).
 * That posting makes buildRegistry auto-discover a phantom greenhouse/notion
 * board ref on the Notion registry entry, which then honestly 404s on every
 * sync run. Deleting the artifact restores a clean sync cycle. No real data is
 * touched — only postings with status=removed, null title and null company.
 */
import { Store } from "./store";

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
const after = await s.getAll();
console.log(`postings after cleanup: ${after.length}`);
