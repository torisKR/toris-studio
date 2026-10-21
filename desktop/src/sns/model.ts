import { invoke } from "@tauri-apps/api/core";
export type Observation = { reportChannelId?:string|null;expiresAt?:string|null;authorizationExpiresAt?:string|null;verificationExpiresAt?:string|null; id?:string; sourceId?:string; platform:string; accountId:string; connectionId?:string|null; sourceKind:"api"|"import"; metric:string; definition:string; unit:string; aggregation:"period"|"cumulative"|"snapshot"; periodStart:string; periodEnd:string; timezone:string; contentId:string; dimensions:Record<string,unknown>; value:number|null; status:"available"|"not_returned"|"unavailable"; observedAt:string; apiVersion:string; provenance:Record<string,unknown> };
export type Source = { reportChannelId?:string|null;id:string; sourceKind:string; platform:string; accountId:string; connectionId?:string|null; label:string; filename:string; digest:string; status:string; metadata:Record<string,unknown>; createdAt:string; removedAt?:string|null };
export type SyncJob = { connectionId:string; platform:string; accountId:string; status:string; lastSyncAt:string|null; nextSyncAt:string|null; cursor:Record<string,unknown>; coverage:Record<string,unknown>; message:string };
export type Capability = { platform:string; apiVersion:string; accountRequirement:string; requiredScopes:string[]; metrics:string[]; history:string; latency:string; limitations:string[]; manualOnly:boolean };
export type AnalyticsStatus = { schemaReady:boolean; migrationRequired:boolean; paused:boolean; jobs:SyncJob[]; capabilities:Capability[]; limits:{maxBytes:number;maxRows:number;maxColumns:number} };
export type Connection = { connectionId:string; platform:string; accountId:string; accountTitle:string; scopes:string[]; readAuthorized:boolean; publishingAuthorized:boolean; connected:boolean; needsReconnect:boolean;revocationPending?:boolean };
export type Binding = { channelId:string; connectionId:string; platform:string; accountId:string };
export type Connections = { connections:Connection[]; bindings?:Binding[]; warnings:unknown[] };
export type Mapping = { date?:string;endDate?:string;contentId?:string;metric?:string;value?:string;metrics?:Record<string,string>;dimensions?:Record<string,string> };
export type ImportPreview = { previewId:string;headers:string[];sample:string[][];rowCount:number;observationCount:number;observations:Observation[];errors:string[];warnings:string[];canCommit:boolean;expiresAt:string };
export const PLATFORM_NAMES:Record<string,string>={youtube:"YouTube",instagram:"Instagram",facebook:"Facebook Page",threads:"Threads",tiktok:"TikTok",naver_blog:"네이버 블로그",naver_clip:"네이버 클립",x:"X"};
export const STATUS_NAMES:Record<string,string>={pending:"수집 대기",running:"수집 중",ready:"수집 완료",partial:"일부 수집",permission_required:"분석 권한 필요",reconnect_required:"다시 연결 필요",rate_limited:"요청 한도 대기",error:"수집 실패",awaiting_report:"보고서 생성 대기"};
export const METRIC_NAMES:Record<string,string>={views:"조회",view_count:"영상 조회",video_thumbnail_impressions:"썸네일 노출",video_thumbnail_impressions_ctr:"썸네일 클릭률",estimatedMinutesWatched:"시청 시간",averageViewDuration:"평균 시청 길이",averageViewPercentage:"평균 시청 비율",subscribersGained:"구독 증가",subscribersLost:"구독 감소",likes:"좋아요",like_count:"좋아요",comments:"댓글",comment_count:"댓글",shares:"공유",share_count:"공유",followers_count:"팔로워",follower_count:"팔로워",reach:"도달",saves:"저장",replies:"답글",reposts:"재게시",quotes:"인용",page_media_view:"페이지 미디어 조회",post_media_view:"게시물 미디어 조회"};
export function analyticsApi<T>(input:Record<string,unknown>):Promise<T>{return invoke<T>("analytics_dispatch",{input});}
export function connectionApi<T>(input:Record<string,unknown>):Promise<T>{return invoke<T>("oauth_connection_dispatch",{input});}
export function accountKey(platform:string,accountId:string){return `${platform}:${accountId}`;}
export function dateRange(days:number,now=new Date()){
 const to=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
 const end=new Date(`${to}T00:00:00Z`);end.setUTCDate(end.getUTCDate()-(days-1));return{from:end.toISOString().slice(0,10),to};
}
export function metricValue(row:Observation){return row.status!=="available"||row.value===null?"—":new Intl.NumberFormat("ko-KR",{maximumFractionDigits:2}).format(row.value);}
export function latestObservations(rows:Observation[]){
 const values=new Map<string,Observation>();
 for(const row of rows){const key=JSON.stringify([row.platform,row.accountId,row.sourceKind,row.sourceId??"",row.metric,row.unit,row.aggregation,row.timezone,row.contentId,row.dimensions]);const prior=values.get(key);if(!prior||`${row.periodEnd}:${row.observedAt}`>`${prior.periodEnd}:${prior.observedAt}`)values.set(key,row);}
 return [...values.values()];
}
export function csvReport(rows:Observation[]){
 const fields:[string,(r:Observation)=>unknown][]=[["platform",r=>r.platform],["accountId",r=>r.accountId],["source",r=>r.sourceKind],["sourceId",r=>r.sourceId],["metric",r=>r.metric],["definition",r=>r.definition],["value",r=>r.value],["status",r=>r.status],["unit",r=>r.unit],["aggregation",r=>r.aggregation],["periodStart",r=>r.periodStart],["periodEnd",r=>r.periodEnd],["timezone",r=>r.timezone],["contentId",r=>r.contentId],["dimensions",r=>JSON.stringify(r.dimensions)],["observedAt",r=>r.observedAt],["apiVersion",r=>r.apiVersion]];
 const cell=(value:unknown)=>{let text=value==null?"":String(value);if(/^[=+@\-\t\r]/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;};
 return "\ufeff"+[fields.map(([name])=>cell(name)).join(","),...rows.map(row=>fields.map(([,read])=>cell(read(row))).join(","))].join("\r\n");
}

/** Local report ownership survives changes to the remote OAuth identity. */
export function scopedObservations(rows:Observation[],channels:{id:string;platform:string}[],bindings:Binding[],filter:{channelId?:string;platform:string;source:string;from:string;to:string},now=Date.now()){
 const selected=channels.find(c=>c.id===filter.channelId);
 const owners=selected?[selected]:channels;
 return rows.filter(row=>{
  if(filter.platform!=="all"&&row.platform!==filter.platform)return false;
  if(filter.source!=="all"&&row.sourceKind!==filter.source)return false;
  if(row.periodEnd<filter.from||row.periodStart>filter.to)return false;
  if(!owners.some(c=>c.platform===row.platform&&(row.sourceKind==="import"?(row.reportChannelId?row.reportChannelId===c.id:row.accountId===c.id):row.accountId===(bindings.find(b=>b.channelId===c.id)?.accountId??c.id))))return false;
  if(row.platform==="youtube"&&row.sourceKind==="api"){
   const deadline=Date.parse(row.expiresAt??"");
   if(!Number.isFinite(deadline)||deadline<=now)return false;
  }
  return true;
 });
}
