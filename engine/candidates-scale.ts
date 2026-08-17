/**
 * REGISTRY SCALE-UP CANDIDATES (owner direction 2026-08-15) — the second,
 * much larger wave of discovery candidates: hundreds of REAL companies drawn
 * from public, robots-respecting sources, merged into the Neon discovery pool
 * by `bun run seed-candidates` (see seed-discovery-pool.ts).
 *
 * Sources (all public, no gated pages, no purchased lists):
 *   1. SCALE_CANDIDATES — curated from public knowledge of which companies
 *      run boards on Greenhouse / Ashby / Lever (their own careers pages and
 *      the ATS vendors' public marketing). `boardId` is the best-known board
 *      token/org/slug; the discovery pass VERIFIES each one live (HTTP 200 +
 *      ≥1 job) before anything enters the registry — a wrong slug is recorded
 *      honestly (http-404 etc.) and never seeded.
 *   2. DIRECTORY_CANDIDATES — company names extracted from the vendors' own
 *      PUBLIC customer pages (lever.co/customers, ashbyhq.com/customers,
 *      fetched 2026-08-17). A company appearing on the vendor's customer page
 *      is a real, high-confidence user of that ATS; the board slug is
 *      normalized from the name (verified live afterward).
 *   3. The shared /home/team/shared/ats-candidates.md file is ALSO seeded
 *      (parsed by seed-discovery-pool.ts — markdown-table aware), so the
 *      team's curated lists and these scale lists all land in one pool.
 *
 * Honesty rules are unchanged: every row here is a GUESS until the daily
 * discovery pass verifies it live through the same politeness layer as the
 * sync (robots.txt + 2s per-host throttle). Only `verified` rows join the
 * registry; failures are counted by reason on the candidate row.
 */

import type { DiscoveryCandidate } from "./candidates";

/**
 * Normalize a company name into the most likely board slug (the ATS org
 * token). The discovery pass verifies the guess live — this just gives the
 * verifier a starting point.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^(the|a|an)/, "")
    .trim();
}

/** Greenhouse additions beyond FALLBACK_CANDIDATES (public knowledge). */
const G_SCALE: [string, string][] = [
  ["2U", "2u"],
  ["23andMe", "23andme"],
  ["Abnormal Security", "abnormalsecurity"],
  ["Addepar", "addepar"],
  ["Airbase", "airbase"],
  ["Airwallex", "airwallex"],
  ["Alation", "alation"],
  ["Alchemy", "alchemy"],
  ["Alloy", "alloy"],
  ["AlphaSights", "alphasights"],
  ["Amperity", "amperity"],
  ["Andela", "andela"],
  ["Anduril", "anduril"],
  ["Appian", "appian"],
  ["AppLovin", "applovin"],
  ["Applied Intuition", "appliedintuition"],
  ["Arctic Wolf", "arcticwolf"],
  ["At-Bay", "atbay"],
  ["Atlassian", "atlassian"],
  ["Attentive", "attentive"],
  ["Aurora", "aurora"],
  ["Avant", "avant"],
  ["AvidXchange", "avidxchange"],
  ["Axon", "axon"],
  ["Better", "better"],
  ["Beyond Meat", "beyondmeat"],
  ["BitGo", "bitgo"],
  ["Blend", "blend"],
  ["Blue Apron", "blueapron"],
  ["BlueVine", "bluevine"],
  ["Bolt", "bolt"],
  ["Box", "box"],
  ["Branch", "branch"],
  ["Bumble", "bumble"],
  ["Calendly", "calendly"],
  ["CarGurus", "cargurus"],
  ["Carta", "carta"],
  ["Census", "census"],
  ["Chainalysis", "chainalysis"],
  ["Chargebee", "chargebee"],
  ["Checkr", "checkr"],
  ["Chegg", "chegg"],
  ["CircleCI", "circleci"],
  ["Clari", "clari"],
  ["ClassPass", "classpass"],
  ["Clearbit", "clearbit"],
  ["Clover Health", "cloverhealth"],
  ["Color Health", "color"],
  ["Compass", "compass"],
  ["Credit Karma", "creditkarma"],
  ["Crunchbase", "crunchbase"],
  ["Culture Amp", "cultureamp"],
  ["Cypress", "cypress"],
  ["Dapper Labs", "dapperlabs"],
  ["DataRobot", "datarobot"],
  ["Dave", "dave"],
  ["DocuSign", "docusign"],
  ["Doximity", "doximity"],
  ["DraftKings", "draftkings"],
  ["Drop", "drop"],
  ["Eargo", "eargo"],
  ["Earnest", "earnest"],
  ["Envoy", "envoy"],
  ["Etsy", "etsy"],
  ["Flexport", "flexport"],
  ["Foursquare", "foursquare"],
  ["Gem", "gem"],
  ["Glossier", "glossier"],
  ["GoFundMe", "gofundme"],
  ["Grubhub", "grubhub"],
  ["Guideline", "guideline"],
  ["Handshake", "handshake"],
  ["Harness", "harness"],
  ["HelloFresh", "hellofresh"],
  ["Hinge", "hinge"],
  ["Hippo", "hippo"],
  ["Hootsuite", "hootsuite"],
  ["iCapital", "icapital"],
  ["ID.me", "idme"],
  ["Impossible Foods", "impossiblefoods"],
  ["Indigo Ag", "indigoag"],
  ["Ipsy", "ipsy"],
  ["Iterable", "iterable"],
  ["JetBlue", "jetblue"],
  ["Jobber", "jobber"],
  ["Justworks", "justworks"],
  ["Kindbody", "kindbody"],
  ["Kong", "kong"],
  ["LaunchDarkly", "launchdarkly"],
  ["LendingClub", "lendingclub"],
  ["Lemonade", "lemonade"],
  ["Lilt", "lilt"],
  ["Lime", "lime"],
  ["Magic Leap", "magicleap"],
  ["Mapbox", "mapbox"],
  ["Marqeta", "marqeta"],
  ["Maven Clinic", "mavenclinic"],
  ["Medium", "medium"],
  ["Mercari", "mercari"],
  ["Moderna", "moderna"],
  ["Motive", "motive"],
  ["Navan", "navan"],
  ["New Relic", "newrelic"],
  ["Nextdoor", "nextdoor"],
  ["Noom", "noom"],
  ["Nuro", "nuro"],
  ["Olo", "olo"],
  ["Omada Health", "omadahealth"],
  ["One Medical", "onemedical"],
  ["OneTrust", "onetrust"],
  ["Opendoor", "opendoor"],
  ["OpenSea", "opensea"],
  ["Oscar Health", "oscarhealth"],
  ["PandaDoc", "pandadoc"],
  ["Patreon", "patreon"],
  ["Petal", "petal"],
  ["Pilot", "pilot"],
  ["Plaid", "plaid"],
  ["Planet", "planet"],
  ["Poshmark", "poshmark"],
  ["Project44", "project44"],
  ["Pulley", "pulley"],
  ["Redfin", "redfin"],
  ["Rent the Runway", "renttherunway"],
  ["Roku", "roku"],
  ["Rothy's", "rothys"],
  ["Samsara", "samsara"],
  ["SeatGeek", "seatgeek"],
  ["ServiceTitan", "servicetitan"],
  ["SevenRooms", "sevenrooms"],
  ["ShipBob", "shipbob"],
  ["Shipt", "shipt"],
  ["Shutterstock", "shutterstock"],
  ["SimpliSafe", "simplisafe"],
  ["Sonos", "sonos"],
  ["SoundHound", "soundhound"],
  ["Spire", "spire"],
  ["SpotHero", "spothero"],
  ["Sprout Social", "sproutsocial"],
  ["Stack Overflow", "stackoverflow"],
  ["Stash", "stash"],
  ["Stitch Fix", "stitchfix"],
  ["StockX", "stockx"],
  ["Substack", "substack"],
  ["Sumo Logic", "sumologic"],
  ["Sweetgreen", "sweetgreen"],
  ["Talkdesk", "talkdesk"],
  ["TaskRabbit", "taskrabbit"],
  ["The Athletic", "theathletic"],
  ["The RealReal", "therealreal"],
  ["Thumbtack", "thumbtack"],
  ["Tinder", "tinder"],
  ["Tock", "tock"],
  ["Tubi", "tubi"],
  ["Udacity", "udacity"],
  ["Upwork", "upwork"],
  ["Veeva", "veeva"],
  ["Vinted", "vinted"],
  ["Vox Media", "voxmedia"],
  ["Wag", "wag"],
  ["Wealthsimple", "wealthsimple"],
  ["Weave", "weave"],
  ["WeWork", "wework"],
  ["Whatnot", "whatnot"],
  ["Wish", "wish"],
  ["Workato", "workato"],
  ["Y Combinator", "ycombinator"],
  ["Zendesk", "zendesk"],
  ["Zenefits", "zenefits"],
  ["Zip", "zip"],
  ["ZoomInfo", "zoominfo"],
  ["Zscaler", "zscaler"],
  ["Zuora", "zuora"],
];

/** Ashby additions beyond FALLBACK_CANDIDATES (public knowledge). */
const A_SCALE: [string, string][] = [
  ["Airtable", "airtable"],
  ["Arize AI", "arize"],
  ["Ashby", "ashby"],
  ["Baseten", "baseten"],
  ["Beeper", "beeper"],
  ["Blackbird", "blackbird"],
  ["Cal.com", "calcom"],
  ["Campsite", "campsite"],
  ["Cargo", "cargo"],
  ["Cesium", "cesium"],
  ["Chatkit", "chatkit"],
  ["Clerk", "clerk"],
  ["Coframe", "coframe"],
  ["Comet", "comet"],
  ["Cornerstone", "cornerstone"],
  ["Dagster Labs", "dagster"],
  ["Deductive", "deductive"],
  ["Dune", "dune"],
  ["Eppo", "eppo"],
  ["Evervault", "evervault"],
  ["Felt", "felt"],
  ["Fireworks AI", "fireworks"],
  ["Fly.io", "flyio"],
  ["Fount", "fount"],
  ["Framer", "framer"],
  ["Fugue", "fugue"],
  ["GetAccept", "getaccept"],
  ["Goodtime", "goodtime"],
  ["Grafbase", "grafbase"],
  ["Grove", "grove"],
  ["Hugging Face", "huggingface"],
  ["Inflection AI", "inflection"],
  ["Jams", "jams"],
  ["Juro", "juro"],
  ["Kandji", "kandji"],
  ["Lago", "lago"],
  ["LangChain", "langchain"],
  ["Lattice", "lattice"],
  ["Linen", "linen"],
  ["Mistral AI", "mistral"],
  ["Neon", "neon"],
  ["Octane", "octane"],
  ["Paragon", "paragon"],
  ["Photoroom", "photoroom"],
  ["Playground", "playground"],
  ["Poolside", "poolside"],
  ["Portable", "portable"],
  ["Prefect", "prefect"],
  ["Propel", "propel"],
  ["Quest", "quest"],
  ["Raycast", "raycast"],
  ["Rippling", "rippling"],
  ["Rocket", "rocket"],
  ["Sentry", "sentry"],
  ["Sift", "sift"],
  ["Speakeasy", "speakeasy"],
  ["Stedi", "stedi"],
  ["Sunsama", "sunsama"],
  ["Synthesia", "synthesia"],
  ["Tally", "tally"],
  ["Temporal", "temporal"],
  ["The Browser Company", "arc"],
  ["Tines", "tines"],
  ["Tome", "tome"],
  ["Truelink", "truelink"],
  ["Vercel", "vercel"],
  ["Voyage", "voyage"],
  ["Warner", "warner"],
  ["Watershed", "watershed"],
  ["WorkOS", "workos"],
  ["Zeplin", "zeplin"],
];

/** Lever additions beyond FALLBACK_CANDIDATES (public knowledge). */
const L_SCALE: [string, string][] = [
  ["Anaconda", "anaconda"],
  ["Babylist", "babylist"],
  ["Cedar", "cedar"],
  ["Codecademy", "codecademy"],
  ["Convoy", "convoy"],
  ["Dataminr", "dataminr"],
  ["Depop", "depop"],
  ["Domo", "domo"],
  ["Eventbrite", "eventbrite"],
  ["Everlane", "everlane"],
  ["Faire", "faire"],
  ["Formlabs", "formlabs"],
  ["G2", "g2"],
  ["GitHub", "github"],
  ["GoCardless", "gocardless"],
  ["Ibotta", "ibotta"],
  ["Indiegogo", "indiegogo"],
  ["Lattice", "lattice"],
  ["Miro", "miro"],
  ["OpenTable", "opentable"],
  ["PagerDuty", "pagerduty"],
  ["Persona", "persona"],
  ["Productboard", "productboard"],
  ["Zeplin", "zeplin"],
];

/**
 * DIRECTORY_CANDIDATES — company names from the ATS vendors' OWN public
 * customer pages (lever.co/customers and ashbyhq.com/customers, fetched
 * 2026-08-17). Real, high-confidence users of each ATS; slugs are normalized
 * guesses verified live by the discovery pass.
 */
const DIRECTORY: [string, "greenhouse" | "ashby" | "lever", string][] = [
  // lever.co/customers logo alt texts (13 companies; Lever itself excluded).
  ["Aircall", "lever", "aircall"],
  ["Autify", "lever", "autify"],
  ["Celerion", "lever", "celerion"],
  ["DREAM Charter Schools", "lever", "dream"],
  ["EnableComp", "lever", "enablecomp"],
  ["Hot Topic", "lever", "hottopic"],
  ["Kinsta", "lever", "kinsta"],
  ["Lucidworks", "lever", "lucidworks"],
  ["Royal Ambulance", "lever", "royalambulance"],
  ["Samba TV", "lever", "sambatv"],
  ["Voro", "lever", "voro"],
  // ashbyhq.com/customers logo alt texts (company names only; people and
  // duplicates with the curated lists above are skipped here — the pool
  // dedupes by candidate_key anyway).
  ["Alan", "ashby", "alan"],
  ["Altura", "ashby", "altura"],
  ["Avid4 Adventure", "ashby", "avid4adventure"],
  ["Boomi", "ashby", "boomi"],
  ["Brightline", "ashby", "brightline"],
  ["Clay", "ashby", "clay"],
  ["Coder", "ashby", "coder"],
  ["Cursor", "ashby", "cursor"],
  ["Deliveroo", "ashby", "deliveroo"],
  ["Eight Sleep", "ashby", "eightsleep"],
  ["Flock", "ashby", "flock"],
  ["Form Energy", "ashby", "formenergy"],
  ["FullStory", "ashby", "fullstory"],
  ["HackerOne", "ashby", "hackerone"],
  ["Harvey", "ashby", "harvey"],
  ["Ironclad", "ashby", "ironclad"],
  ["January", "ashby", "january"],
  ["Lemonade", "ashby", "lemonade"],
  ["Lime", "ashby", "lime"],
  ["Linear", "ashby", "linear"],
  ["Marqeta", "ashby", "marqeta"],
  ["Mercury", "ashby", "mercury"],
  ["Multiverse", "ashby", "multiverse"],
  ["NETGEAR", "ashby", "netgear"],
  ["Notion", "ashby", "notion"],
  ["PostHog", "ashby", "posthog"],
  ["Ramp", "ashby", "ramp"],
  ["Reddit", "ashby", "reddit"],
  ["Replit", "ashby", "replit"],
  ["Retool", "ashby", "retool"],
  ["Sequoia", "ashby", "sequoia"],
  ["Shopify", "ashby", "shopify"],
  ["Sierra", "ashby", "sierra"],
  ["Snowflake", "ashby", "snowflake"],
  ["UiPath", "ashby", "uipath"],
  ["Vanta", "ashby", "vanta"],
  ["Xero", "ashby", "xero"],
  ["Zapier", "ashby", "zapier"],
];

function rows(list: [string, string][], board: "greenhouse" | "ashby" | "lever"): DiscoveryCandidate[] {
  return list.map(([name, boardId]) => ({ name, board, boardId }));
}

/** The curated scale wave (public-knowledge lists). */
export const SCALE_CANDIDATES: DiscoveryCandidate[] = [
  ...rows(G_SCALE, "greenhouse"),
  ...rows(A_SCALE, "ashby"),
  ...rows(L_SCALE, "lever"),
];

/** Directory-derived candidates (vendor customer pages). */
export const DIRECTORY_CANDIDATES: DiscoveryCandidate[] = DIRECTORY.map(([name, board, boardId]) => ({
  name,
  board,
  boardId,
}));

export const SCALE_WAVE_TOTALS = {
  curated: SCALE_CANDIDATES.length,
  directory: DIRECTORY_CANDIDATES.length,
  byBoard: {
    greenhouse: SCALE_CANDIDATES.filter((c) => c.board === "greenhouse").length,
    ashby: SCALE_CANDIDATES.filter((c) => c.board === "ashby").length,
    lever: SCALE_CANDIDATES.filter((c) => c.board === "lever").length,
  } as Record<string, number>,
};
