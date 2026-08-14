import { Store } from "./store";

const s = new Store();
const all = await s.getAll();
const byBoard: Record<string, number> = {};
const byStatus: Record<string, number> = {};
for (const r of all) {
  byBoard[r.sourceBoard] = (byBoard[r.sourceBoard] ?? 0) + 1;
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
}
console.log("postings:", all.length);
console.log("byBoard:", JSON.stringify(byBoard));
console.log("byStatus:", JSON.stringify(byStatus));
console.log("sync_cursor:", await s.getMetaInt("sync_cursor", -1));
console.log("companies:", JSON.stringify([...new Set(all.map((r) => r.company))]));
