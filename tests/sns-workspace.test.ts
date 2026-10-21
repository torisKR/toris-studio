import test from "node:test";
import assert from "node:assert/strict";
import { dateRange, metricValue, latestObservations, csvReport, accountKey, type Observation } from "../desktop/src/sns/model";
const row = (patch: Partial<Observation> = {}): Observation => ({ platform:"youtube",accountId:"a",sourceKind:"api",metric:"views",definition:"Views",unit:"count",aggregation:"period",periodStart:"2026-10-01",periodEnd:"2026-10-01",timezone:"America/Los_Angeles",contentId:"",dimensions:{},value:0,status:"available",observedAt:"2026-10-03T00:00:00Z",apiVersion:"v3",provenance:{},...patch });
test("missing values remain distinct from actual zero and source identity is not merged", () => {
 assert.equal(metricValue(row()), "0");
 assert.equal(metricValue(row({value:null,status:"not_returned"})), "—");
 assert.notEqual(accountKey("youtube","a"),accountKey("tiktok","a"));
 const values=latestObservations([row(),row({sourceKind:"import",sourceId:"i"}),row({platform:"tiktok"})]);
 assert.equal(values.length,3);
});
test("date range uses calendar dates and exported values cannot become spreadsheet formulas", () => {
 assert.deepEqual(dateRange(7,new Date("2026-10-21T03:00:00Z")),{from:"2026-10-15",to:"2026-10-21"});
 const csv=csvReport([row({metric:"=HYPERLINK(\"x\")",value:18})]);
 assert.match(csv, /'=HYPERLINK/);
 assert.match(csv,/America\/Los_Angeles/);
 assert.match(csv,/api/);
});
