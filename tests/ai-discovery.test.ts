import assert from "node:assert/strict";
import test from "node:test";
import { materialFromTrend, addReference, composeContext, discoveryItems, keywordChoices, applyMaterial, chatBrief } from "../desktop/src/ai-discovery";
import type { SocialTrend, KeywordContent } from "../desktop/src/types";
const trend: SocialTrend={id:"one",source:"youtube",keyword:"AI 생산성",title:"로컬 AI 활용",url:"https://www.youtube.com/watch?v=abcdefghijk",metric:null,region:"KR",publishedAt:null,fetchedAt:"2026-10-09T00:00:00Z",details:{discovery:"youtube_keyword",description:"실제 제공된 설명입니다."}};
test("brief carries real source excerpt and collection time without inventing facts",()=>{
  const material=materialFromTrend(trend);
  const context=composeContext("직접 작성한 맥락",[material]);
  assert.match(context,/직접 작성한 맥락/);assert.match(context,/실제 제공된 설명입니다/);assert.match(context,/abcdefghijk/);assert.match(context,/2026-10-09/);
  assert.doesNotMatch(context,/인기 순위|원문 확인 완료/);
});
test("topic/reference actions are separate, repeat selection is idempotent and overlimit is atomic",()=>{
  const material=materialFromTrend(trend);
  const original={topic:"내 주제",context:"내 맥락",references:[]};
  const topic=applyMaterial(original,material,"topic");assert.equal(topic.topic,"AI 생산성");assert.deepEqual(topic.references,[]);assert.equal(topic.context,"내 맥락");
  const references=applyMaterial(original,material,"reference");assert.equal(references.topic,"내 주제");assert.equal(references.context,"내 맥락");
  assert.equal(addReference(references.references,{...material,id:"other-id"}).length,1);
  assert.equal(applyMaterial(references,material,"both").references.length,1);
  assert.throws(()=>applyMaterial({...original,context:"가".repeat(6000)},material,"both"),/6000/);assert.equal(original.topic,"내 주제");
});
test("a matching source upgrades its description to body evidence without duplicate references",()=>{
  const description=materialFromTrend(trend);
  const other=materialFromTrend({...trend,id:"other",url:"https://example.com/other",details:{...trend.details,description:"다른 출처의 설명입니다."}});
  const original=[description,other];
  const body=materialFromTrend({...trend,id:"new-observation"},"원문 키워드","새로 수집한 실제 본문입니다.");
  const upgraded=addReference(original,body);
  assert.equal(upgraded.length,2);assert.equal(upgraded[0],body);assert.equal(upgraded[1],other);
  assert.equal(original[0],description);assert.equal(original[0].excerptKind,"description");
  const context=composeContext("직접 작성한 맥락",upgraded);
  assert.match(context,/새로 수집한 실제 본문입니다/);assert.match(context,/"excerptType":"body"/);
  assert.doesNotMatch(context,/실제 제공된 설명입니다/);
});
test("repeat selection is idempotent and a description cannot downgrade existing body evidence",()=>{
  const description=materialFromTrend(trend);
  const descriptions=[description];
  assert.equal(addReference(descriptions,{...description}),descriptions);
  const body=materialFromTrend(trend,trend.keyword,"실제 수집된 본문을 보존합니다.");
  const upgraded=addReference(descriptions,body);
  assert.equal(addReference(upgraded,{...body}),upgraded);
  assert.equal(addReference(upgraded,{...description,id:"another-observation"}),upgraded);
  assert.equal(upgraded.length,1);assert.equal(upgraded[0].excerpt,body.excerpt);
});
test("an over-budget body upgrade leaves the existing brief unchanged",()=>{
  const description=materialFromTrend(trend);
  const references=[description];
  const context="가".repeat(6000-composeContext("",references).length-2);
  const original={topic:"기존 주제",context,references};
  const before=structuredClone(original);
  assert.equal(composeContext(context,references).length,6000);
  const body=materialFromTrend(trend,"새 주제","긴 원문입니다. ".repeat(100));
  assert.throws(()=>applyMaterial(original,body,"both"),/6000/);
  assert.deepEqual(original,before);assert.equal(original.references,references);
});
test("discovery deduplicates by canonical source URL, sorts newest first, caps at six and omits unsafe sources",()=>{
  const items=Array.from({length:9},(_,i)=>({...trend,id:String(i),url:`https://example.com/${i}`,fetchedAt:`2026-10-${String(i+1).padStart(2,"0")}T00:00:00Z`}));
  const selected=discoveryItems([...items,{...items[8],id:"duplicate"},{...trend,id:"unsafe",url:"javascript:alert(1)"}]);
  assert.equal(selected.length,6);assert.equal(selected[0].trend.id,"8");
  assert.throws(()=>materialFromTrend({...trend,url:"https://secret@example.com/"}),/출처/);
});
test("observed and extracted keywords retain their provenance and associated material",()=>{
  const item:KeywordContent={trend,matches:[],observedKeywords:[{keyword:"실제 검색어",source:"youtube",observedAt:trend.fetchedAt}],extractedKeywords:[{keyword:"추출 단어",score:2,occurrences:1}]};
  const choices=keywordChoices([item]);assert.equal(choices[0].kind,"observed");assert.equal(choices[1].kind,"extracted");assert.equal(choices[1].material.trend.url,trend.url);
  assert.match(chatBrief("youtube","내 주제","맥락",[materialFromTrend(trend)]),/직접/);
});
test("ChatGPT content handoff keeps the connected project instead of forcing the developer checkout",()=>{
  const brief=chatBrief("youtube","내 주제","맥락",[materialFromTrend(trend)]);
  assert.doesNotMatch(brief,/\/Users\/toris\/projects\/toris_studio/);
  assert.match(brief,/프로젝트를 전환하거나 기존 Studio 저장 폴더를 변경하지 마/);
  assert.match(brief,/studio__studio_asset_receive/);
  assert.match(brief,/내 주제/);assert.match(brief,/abcdefghijk/);
});
