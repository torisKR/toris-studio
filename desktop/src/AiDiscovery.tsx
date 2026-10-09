import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Check, Hash, RefreshCw, Sparkles, X } from "lucide-react";
import { ActivitySkeleton, ActivityStatus } from "./ActivityStatus";
import { External } from "./External";
import { discoveryItems,keywordChoices } from "./ai-discovery";
import type { AiMaterial,AiSelectionMode } from "./ai-discovery";
import type { KeywordSearchResult,SocialTrend } from "./types";
import "./AiDiscovery.css";
const names={youtube:"YouTube",naver_blog:"네이버",google_trends:"Google 트렌드"};
function date(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?"수집 시각 미제공":d.toLocaleString("ko-KR",{timeZone:"Asia/Seoul",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}
export function AiDiscovery({trends,loading,databaseConnected,busy,references,onSelect,onRefresh,onExplore}:{trends:SocialTrend[];loading:boolean;databaseConnected:boolean;busy:boolean;references:AiMaterial[];onSelect:(material:AiMaterial,mode:AiSelectionMode)=>void;onRefresh:()=>Promise<void>;onExplore:()=>void}){
 const [result,setResult]=useState<KeywordSearchResult|null>(null),[reading,setReading]=useState(false),[error,setError]=useState("");
 const [selectedKey,setSelectedKey]=useState<string|null>(null);
 const sequence=useRef(0),pending=useRef<number|null>(null);
 const reload=useCallback(async()=>{
  if(!databaseConnected||pending.current!==null)return;const id=++sequence.current;pending.current=id;setReading(true);setError("");
  try{const data=await invoke<KeywordSearchResult>("search_keywords",{input:{query:"",mode:"local",source:"all",limit:25,offset:0}});if(sequence.current===id)setResult(data);}
  catch(e){if(sequence.current===id)setError(typeof e==="string"?e:e instanceof Error?e.message:"키워드 자료를 불러오지 못했습니다.");}
  finally{if(pending.current===id)pending.current=null;if(sequence.current===id)setReading(false);}
 },[databaseConnected]);
 useEffect(()=>{
  if(databaseConnected)void reload();else setReading(false);
  return()=>{sequence.current++;pending.current=null;};
 },[databaseConnected,reload]);
 const candidates=useMemo(()=>discoveryItems(trends),[trends]);
 const choices=useMemo(()=>keywordChoices(result?.items??[]),[result]);
 const selected=choices.find(c=>c.key===selectedKey);
 return <section className="ai-discovery" aria-label="주제 발견과 자료 선택">
  <div className="ai-discovery-heading"><div><h2>오늘의 주제 후보</h2><p>최근 수집 자료에서 골라보세요. 인기 순위가 아닌 주제 탐색용 목록입니다.</p></div><div><button type="button" className="social-button compact" disabled={reading||loading} onClick={()=>{void reload();void onRefresh();}} aria-label="수집 자료 새로고침"><RefreshCw size={14}/>새로고침</button><button type="button" className="social-button compact subtle" onClick={onExplore}>더 탐색하기<ArrowUpRight size={14}/></button></div></div>
  {(loading||reading)&&<ActivityStatus title="주제 후보를 불러오는 중" detail="저장된 트렌드와 키워드를 읽습니다. 이미 선택한 자료와 직접 입력한 내용은 유지합니다."/>}
  <div className="ai-discovery-columns">
   <div className="ai-trend-summary">
    {loading&&!candidates.length?<ActivitySkeleton label="트렌드 요약 준비 중"/>:candidates.length?<ol>{candidates.map(material=><li key={material.id}><div className="ai-source-line"><span>{names[material.trend.source]}</span><time dateTime={material.trend.fetchedAt}>{date(material.trend.fetchedAt)}</time></div><h3><External url={material.trend.url}>{material.trend.title}<ArrowUpRight size={13}/></External></h3><p>{material.excerpt||"원본 설명이 제공되지 않았습니다."}</p><div className="ai-material-actions"><button type="button" disabled={busy} onClick={()=>onSelect(material,"topic")}><Hash size={13}/>주제로 사용</button><button type="button" disabled={busy} aria-pressed={references.some(r=>r.trend.url===material.trend.url)} onClick={()=>onSelect(material,"reference")}>{references.some(r=>r.trend.url===material.trend.url)?<Check size={13}/>:<BookOpen size={13}/>}참고자료 추가</button><button type="button" disabled={busy} onClick={()=>onSelect(material,"both")}><Sparkles size={13}/>함께 사용</button></div></li>)}</ol>:<div className="ai-discovery-empty"><Hash size={24}/><strong>수집한 자료에서 시작하세요</strong><p>트렌드 탐색에서 자료를 수집하면 실제 제목과 출처를 여기서 선택할 수 있습니다.</p><button className="social-button compact" onClick={onExplore}>트렌드 탐색 열기</button></div>}
   </div>
   <aside className="ai-keyword-summary" aria-label="실제 검색어와 추출 키워드"><h3>키워드로 좁혀보기</h3><p>키워드를 고른 뒤 주제 또는 자료로 적용하세요.</p>{error&&<p className="social-form-error" role="alert">{error} {result?"이전 조회 자료를 유지합니다.":"키워드 연결을 확인하세요."}</p>}{reading&&!result?<ActivitySkeleton label="관련 키워드 준비 중" rows={2}/>:<>{(["observed","extracted"] as const).map(kind=><div key={kind} className="ai-keyword-group"><h4>{kind==="observed"?"실제 검색어":"추출 키워드"}</h4><div>{choices.filter(c=>c.kind===kind).map(choice=><button type="button" key={choice.key} className="ai-keyword-chip" disabled={busy} aria-pressed={choice.key===selectedKey} aria-label={`${choice.keyword} · ${kind==="observed"?"실제 검색어":"추출 키워드"}`} onClick={()=>setSelectedKey(choice.key)}><Hash size={12}/>{choice.keyword}</button>)}</div>{!choices.some(c=>c.kind===kind)&&<p className="ai-keyword-empty">{databaseConnected?"저장된 키워드가 없습니다.":"DB 연결 후 확인할 수 있습니다."}</p>}</div>)}</>}
    {selected&&<div className="ai-keyword-selection"><div><strong>{selected.keyword}</strong><button className="social-dismiss" aria-label="키워드 선택 해제" onClick={()=>setSelectedKey(null)}><X size={14}/></button></div><p>연결 자료: {selected.material.trend.title}</p><div className="ai-material-actions"><button type="button" disabled={busy} aria-label="선택한 키워드를 주제로 사용" onClick={()=>onSelect(selected.material,"topic")}>주제로 사용</button><button type="button" disabled={busy} aria-label="선택한 키워드를 참고자료로 추가" onClick={()=>onSelect(selected.material,"reference")}>참고자료 추가</button><button type="button" disabled={busy} aria-label="선택한 키워드를 주제와 자료로 사용" onClick={()=>onSelect(selected.material,"both")}>주제 + 자료</button></div></div>}
    <small>최근 조회 자료 {result?.items.length??0}개 기준 · 같은 단어도 검색어와 추출 결과는 구분합니다.</small>
   </aside>
  </div>
 </section>;
}
