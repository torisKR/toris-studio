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

test("calendar ranges do not parse locale display dates and cross KST year and leap-day boundaries", (t) => {
 const DateTimeFormat = Intl.DateTimeFormat;
 t.mock.method(Intl, "DateTimeFormat", function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
  const formatter = new DateTimeFormat(locales, options);
  // Locale display formatting is not an ISO serialization contract. Exercise
  // slash-separated display output without changing the actual calendar parts.
  Object.defineProperty(formatter, "format", { value: () => "01/01/2020" });
  return formatter;
 });
 assert.deepEqual(dateRange(7,new Date("2019-12-31T15:00:00Z")),{from:"2019-12-26",to:"2020-01-01"});
 assert.deepEqual(dateRange(1,new Date("2019-12-31T14:59:59Z")),{from:"2019-12-31",to:"2019-12-31"});
 assert.deepEqual(dateRange(2,new Date("2024-02-28T15:00:00Z")),{from:"2024-02-28",to:"2024-02-29"});
});

test("selected channel and source never expose another account, while report ownership survives binding",async()=>{
 const {scopedObservations}=await import("../desktop/src/sns/model");
 const channels=[{id:"local-a",platform:"youtube"},{id:"local-b",platform:"youtube"}];
 const bindings=[{channelId:"local-a",connectionId:"grant-a",platform:"youtube",accountId:"remote-a"}];
 const filter={channelId:"local-a",platform:"all",source:"all",from:"2026-10-15",to:"2026-10-21"};
 const api=row({accountId:"remote-a",expiresAt:"2026-11-01T00:00:00Z",periodStart:"2026-10-01",periodEnd:"2026-10-31"});
 const report=row({accountId:"local-a",sourceKind:"import",periodStart:"2026-10-01",periodEnd:"2026-10-31",value:18});
 const other=row({accountId:"local-b",sourceKind:"import",periodStart:"2026-10-21",periodEnd:"2026-10-21"});
 const now=Date.parse("2026-10-21T00:00:00Z");
 assert.deepEqual(scopedObservations([api,report,other],channels,bindings,filter,now),[api,report]);
 assert.deepEqual(scopedObservations([api,report,other],channels,bindings,{...filter,source:"import"},now),[report]);
 assert.deepEqual(scopedObservations([api,report,other],channels,bindings,{...filter,channelId:"local-b"},now),[other]);
 assert.deepEqual(scopedObservations([report],channels,[],filter,now),[report]);
 assert.equal(report.periodStart,"2026-10-01");assert.equal(report.value,18);
 assert.deepEqual(scopedObservations([api,{...api,expiresAt:null}],channels,bindings,filter,Date.parse("2026-11-01")),[]);
});


test("native report owner survives rebind and never follows a reused remote account",async()=>{
 const {scopedObservations}=await import("../desktop/src/sns/model");
 const channels=[{id:"local-a",platform:"x"},{id:"local-b",platform:"x"}];
 const bindings=[{channelId:"local-a",connectionId:"grant-b",platform:"x",accountId:"remote-b"},{channelId:"local-b",connectionId:"grant-a",platform:"x",accountId:"remote-a"}];
 const original=row({platform:"x",sourceKind:"import",accountId:"remote-a",reportChannelId:"local-a",value:123});
 const other=row({platform:"x",sourceKind:"import",accountId:"remote-b",reportChannelId:"local-b",value:456});
 const unknown=row({platform:"x",sourceKind:"import",accountId:"remote-a"});
 const filter={channelId:"local-a",platform:"all",source:"all",from:"2026-10-01",to:"2026-10-31"};
 assert.deepEqual(scopedObservations([original,other,unknown],channels,bindings,filter),[original]);
 assert.deepEqual(scopedObservations([original,other,unknown],channels,bindings,{...filter,channelId:"local-b"}),[other]);
 assert.equal(original.accountId,"remote-a");assert.equal(original.value,123);
});
