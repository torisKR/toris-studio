import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import type { View } from "./workspace-navigation";
import { creationApi, type CreationRequest } from "./creation-client";
import { analyticsApi, STATUS_NAMES, type AnalyticsStatus } from "./sns/model";
type Item={id:string;title:string;status:string;view:View;focus?:"queue"};
const stamp=(iso:string)=>{const d=new Date(iso);return Number.isNaN(+d)?"":d.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});};
export function OperationTray({onNavigate}:{onNavigate:(view:View,focus?:"queue")=>void}){
 const [open,setOpen]=useState(false),[items,setItems]=useState<Item[]>([]),[warnings,setWarnings]=useState(0);
 const region=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{let alive=true,reading=false;const read=async()=>{if(reading)return;reading=true;const results=await Promise.allSettled([
  creationApi<{requests:CreationRequest[]}>("list"),
  invoke<{publications:{title:string;jobs?:{id:string;status:string;accountTitle?:string}[]}[]}>("publication_list"),
  analyticsApi<AnalyticsStatus>({action:"status"}),
  invoke<{jobs:{id:string;status:string;createdAt:string;spec:{title:string}}[]}>("asset_command",{action:"snapshot",input:{jobLimit:30,limit:1}}),
  invoke<{id:string;instruction:string;status:string}[]>("motion_request_list")
 ]);const output:Item[]=[];
 if(results[0].status==="fulfilled")for(const r of results[0].value.requests.filter(r=>r.status!=="cancelled").slice(0,10))output.push({id:r.id,title:r.title,status:r.status==="draft-received"?"초안 수신 · 검토 필요":r.status==="read"?"실제 요청 조회 확인":"요청 저장 · 전달 필요",view:r.kind==="video"?"video":"ai"});
 if(results[1].status==="fulfilled")for(const p of results[1].value.publications)for(const j of p.jobs??[])if(!["published","cancelled"].includes(j.status))output.push({id:j.id,title:`${p.title} · ${j.accountTitle??"게시 대상"}`,status:({queued:"게시 대기",scheduled:"승인된 예약",sending:"전송 중",processing:"플랫폼 처리 중",uncertain:"결과 확인 필요",needs_confirmation:"재승인 필요",needs_human_publish:"수동 게시 필요",failed:"게시 실패",draft_sent:"사용자 최종 게시 필요"} as Record<string,string>)[j.status]??j.status,view:"publications"});
 if(results[2].status==="fulfilled")for(const j of results[2].value.jobs)output.push({id:`${j.connectionId}:${j.accountId}`,title:`${j.platform} 분석`,status:STATUS_NAMES[j.status]??j.status,view:"sns"});
 if(results[3].status==="fulfilled")for(const j of results[3].value.jobs??[])if(!["completed","cancelled"].includes(j.status))output.push({id:j.id,title:j.spec.title,status:["실제 파일 수신 대기",stamp(j.createdAt)].filter(Boolean).join(" · "),view:"assets",focus:"queue"});
 if(results[4].status==="fulfilled")for(const r of results[4].value??[])if(!["cancelled","applied"].includes(r.status))output.push({id:r.id,title:r.instruction?.slice(0,80)||"모션 요청",status:r.status==="received"?"모션 초안 검토 필요":"모션 초안 대기",view:"video"});
 if(alive){setItems(output);setWarnings(results.filter(r=>r.status==="rejected").length);}reading=false;};void read();const timer=setInterval(()=>void read(),15000);return()=>{alive=false;clearInterval(timer);};},[]);
 useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!region.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){setOpen(false);trigger.current?.focus();}};document.addEventListener("pointerdown",close);document.addEventListener("keydown",key);return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",key);};},[open]);
 return <div className="workspace-operation-tray"><button className="social-button compact" ref={trigger} aria-expanded={open} aria-controls="workspace-jobs" onClick={()=>setOpen(v=>!v)}><Activity size={16}/><span>작업함</span>{items.length>0&&<small>{items.length}</small>}</button>{open&&<div className="workspace-jobs" id="workspace-jobs" ref={region} aria-label="진행 중인 작업"><header><strong>내 작업</strong><button className="social-dismiss" aria-label="작업함 닫기" onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={17}/></button></header>{!items.length&&<p>확인할 작업이 없습니다.</p>}{items.slice(0,30).map(item=><button key={item.id} className="workspace-job" onClick={()=>{onNavigate(item.view,item.focus);setOpen(false);}}><strong>{item.title}</strong><span>{item.status}</span></button>)}{warnings>0&&<p className="social-muted">일부 작업 저장소를 읽지 못했습니다. 해당 화면에서 다시 확인하세요.</p>}<footer>화면을 이동해도 작업을 유지합니다. 상세 기록은 각 작업에서 확인하세요.</footer></div>}</div>;
}
