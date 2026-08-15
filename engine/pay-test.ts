/**
 * PAY-SIGNAL TESTS — extraction + cross-listing consistency
 * (owner decision 2026-08-15). Pure logic, no network, no store writes.
 *
 * Run: bun run engine/pay-test.ts
 *
 * Covers:
 *   1. Text extraction: ranges, k-forms, hourly, currencies, no-period,
 *      false-positive guards ("$10 Uber credits" is not a salary).
 *   2. Structured extraction: Greenhouse compensation, Ashby/Lever
 *      salaryRange, schema.org JSON-LD baseSalary.
 *   3. Body extraction: JSON payloads (structured then description text),
 *      HTML pages (JSON-LD then visible text).
 *   4. Consistency: conflict case, consistent case (incl. close/overlapping
 *      bands and period normalization hour vs year), missing-pay case,
 *      only-one-listing, different currencies, not-checked.
 */
import { extractPayFromBody, extractPayFromStructured, extractPayFromText, payConsistency, bandsConflict } from "./pay";
import type { PayInfo, PayPeriod } from "./types";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
}

function payRow(id: string, min: number | null, max: number | null, period: PayPeriod | null = "year", currency = "USD"): PayInfo {
  return {
    postingId: id,
    hasPay: min != null || max != null,
    payMin: min,
    payMax: max,
    currency,
    period,
    payText: null,
    source: "structured",
    fetchError: null,
    extractedAt: "2026-08-01T00:00:00.000Z",
  };
}
function noPayRow(id: string): PayInfo {
  return { postingId: id, hasPay: false, payMin: null, payMax: null, currency: null, period: null, payText: null, source: null, fetchError: null, extractedAt: "2026-08-01T00:00:00.000Z" };
}

console.log("== text extraction ==");
const r1 = extractPayFromText("Salary range: $120,000 – $150,000 per year.");
check("range with per year", { min: r1?.min, max: r1?.max, currency: r1?.currency, period: r1?.period }, { min: 120000, max: 150000, currency: "USD", period: "year" });
const r2 = extractPayFromText("Compensation: $120k-$150k, plus equity.");
check("k-form range", { min: r2?.min, max: r2?.max }, { min: 120000, max: 150000 });
const r3 = extractPayFromText("Hourly rate $45 - $60 per hour");
check("hourly range", { min: r3?.min, max: r3?.max, period: r3?.period }, { min: 45, max: 60, period: "hour" });
const r4 = extractPayFromText("The salary is €70,000 to €80,000 annually.");
check("euro range", { min: r4?.min, max: r4?.max, currency: r4?.currency, period: r4?.period }, { min: 70000, max: 80000, currency: "EUR", period: "year" });
const r5 = extractPayFromText("Base pay: £50k-£60k");
check("pound k range no period", { min: r5?.min, max: r5?.max, currency: r5?.currency, period: r5?.period }, { min: 50000, max: 60000, currency: "GBP", period: null });
const r6 = extractPayFromText("up to $150,000 depending on experience");
check("single 'up to' value", { min: r6?.min, max: r6?.max, period: r6?.period }, { min: 150000, max: null, period: null });
check("'$10 Uber credits' is NOT a salary", extractPayFromText("We offer $10 Uber credits each month."), null);
check("no currency -> no pay", extractPayFromText("Requires 5 years of experience in 10+ projects."), null);
const r7 = extractPayFromText("We pay $120,000 - $150,000 for this role. Full-time, 40 hours per week.");
check("period near match is 'year'-less but amount plausible", { min: r7?.min, max: r7?.max }, { min: 120000, max: 150000 });

console.log("== structured extraction ==");
const gh = extractPayFromStructured({ compensation: { min: 120000, max: 150000, currency: "USD", interval: "year" } });
check("greenhouse compensation", { min: gh?.min, max: gh?.max, currency: gh?.currency, period: gh?.period }, { min: 120000, max: 150000, currency: "USD", period: "year" });
const ashby = extractPayFromStructured({ salaryRange: { min: 45000, max: 60000, currency: "USD", interval: "hour" } });
check("ashby salaryRange hourly", { min: ashby?.min, max: ashby?.max, period: ashby?.period }, { min: 45000, max: 60000, period: "hour" });
const ld = extractPayFromStructured({ "@type": "JobPosting", baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 80000, maxValue: 100000, unitText: "YEAR" } } });
check("json-ld baseSalary", { min: ld?.min, max: ld?.max, currency: ld?.currency, period: ld?.period }, { min: 80000, max: 100000, currency: "USD", period: "year" });

console.log("== body extraction ==");
const jsonBody = JSON.stringify({ jobs: [{ id: "1", title: "Engineer", compensation: { min: 100000, max: 150000, currency: "USD", interval: "year" }, content: "<p>hello</p>" }] });
const b1 = extractPayFromBody(jsonBody, "application/json");
check("json body structured pay", { min: b1?.min, max: b1?.max, source: b1?.source }, { min: 100000, max: 150000, source: "structured" });
const jsonText = JSON.stringify({ jobs: [{ id: "1", title: "Engineer", descriptionHtml: "<p>Salary: $95,000 - $115,000 per year</p>" }] });
const b2 = extractPayFromBody(jsonText, "application/json");
check("json body description text pay", { min: b2?.min, max: b2?.max, source: b2?.source }, { min: 95000, max: 115000, source: "description" });
const htmlBody = `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "X", baseSalary: { currency: "USD", value: { minValue: 60000, maxValue: 80000, unitText: "YEAR" } } })}</script></head><body><h1>X</h1></body></html>`;
const b3 = extractPayFromBody(htmlBody, "text/html");
check("html json-ld pay", { min: b3?.min, max: b3?.max, source: b3?.source }, { min: 60000, max: 80000, source: "structured" });
const htmlText = "<html><body><p>We are hiring! Salary range $70,000 - $90,000 per year. Apply today.</p></body></html>";
const b4 = extractPayFromBody(htmlText, "text/html");
check("html text pay", { min: b4?.min, max: b4?.max, source: b4?.source }, { min: 70000, max: 90000, source: "description" });

console.log("== consistency ==");
check("conflict: $120-150k vs $90-100k", payConsistency([payRow("a", 120000, 150000), payRow("b", 90000, 100000)]).verdict, "conflict");
check("consistent: identical bands", payConsistency([payRow("a", 120000, 150000), payRow("b", 120000, 150000)]).verdict, "consistent");
check("consistent: overlapping close bands", payConsistency([payRow("a", 120000, 150000), payRow("b", 130000, 160000)]).verdict, "consistent");
check("consistent: single value vs wider band containing it", payConsistency([payRow("a", 120000, 120000), payRow("b", 110000, 140000)]).verdict, "consistent");
check("consistent: hour vs year normalized (45/hr ≈ 93.6k vs 90-100k)", payConsistency([payRow("a", 45, 45, "hour"), payRow("b", 90000, 100000)]).verdict, "consistent");
check("conflict: hour vs year far apart (45/hr vs 50-60k)", payConsistency([payRow("a", 45, 45, "hour"), payRow("b", 50000, 60000)]).verdict, "conflict");
check("missing pay -> not-stated", payConsistency([noPayRow("a"), noPayRow("b")]).verdict, "not-stated");
check("one pay + one missing -> only-one-listing", payConsistency([payRow("a", 120000, 150000), noPayRow("b")]).verdict, "only-one-listing");
check("different currencies -> conflict", payConsistency([payRow("a", 120000, 150000, "year", "USD"), payRow("b", 110000, 140000, "year", "EUR")]).verdict, "conflict");
check("empty group -> not-checked", payConsistency([]).verdict, "not-checked");
check("bandsConflict unit: separated >10% midpoint gap", bandsConflict({ min: 50000, max: 60000 }, { min: 120000, max: 150000 }), true);
check("bandsConflict unit: overlapping", bandsConflict({ min: 120000, max: 150000 }, { min: 130000, max: 160000 }), false);
check("bandsConflict unit: 8% gap is tolerated", bandsConflict({ min: 100000, max: 110000 }, { min: 110000, max: 120000 }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
