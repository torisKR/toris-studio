import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./ActivityStatus.css";
/** Activity, not simulated progress. The clock is observational and is not a live announcement. */
export function ActivityStatus({title,detail,state="running",children,clock=true,since}:{title:string;detail?:string;state?:"running"|"waiting";children?:ReactNode;clock?:boolean;since?:number}) {
  const element=useRef<HTMLDivElement>(null);
  const started=useRef(Date.now());
  const [seconds,setSeconds]=useState(0),[visible,setVisible]=useState(true),[paused,setPaused]=useState(false);
  useEffect(()=>{
    started.current=since??Date.now();setSeconds(Math.max(0,Math.floor((Date.now()-started.current)/1000)));
    if(!clock)return;
    const tick=()=>{if(document.visibilityState==="visible")setSeconds(Math.floor((Date.now()-started.current)/1000));};
    const timer=setInterval(tick,1000);return()=>clearInterval(timer);
  },[title,clock,since]);
  useEffect(()=>{
    let onScreen=true;
    const update=()=>setVisible(onScreen&&document.visibilityState==="visible");
    const observer=new IntersectionObserver(entries=>{onScreen=entries[0]?.isIntersecting??false;update();});
    if(element.current)observer.observe(element.current);
    document.addEventListener("visibilitychange",update);update();
    return()=>{observer.disconnect();document.removeEventListener("visibilitychange",update);};
  },[]);
  const elapsed=seconds<60?`${seconds}초`:`${Math.floor(seconds/60)}분 ${seconds%60}초`;
  return <div ref={element} className={`activity-status ${state}`} data-paused={!visible||paused}>
    <div className="activity-line"><span className="activity-indicator" aria-hidden="true"><span/><span/><span/></span><strong role="status" aria-live="polite">{title}</strong>{clock&&<span className="activity-elapsed" aria-live="off">{elapsed} 경과</span>}<button type="button" className="activity-pause" onClick={()=>setPaused(!paused)} aria-pressed={paused} aria-label={paused?"상태 애니메이션 재생":"상태 애니메이션 일시정지"}>{paused?"효과 재생":"효과 멈춤"}</button></div>
    {detail&&<details className="activity-help"><summary>작업 안내</summary><p>{detail}</p></details>}
    {children&&<div className="activity-actions">{children}</div>}
  </div>;
}
export function ActivitySkeleton({label,rows=3,showStatus=false}:{label:string;rows?:number;showStatus?:boolean}) {
  return <div className="activity-skeleton" aria-label={label}>{showStatus?<ActivityStatus title={label} clock={false}/>:<span className="social-sr-only" role="status">{label}</span>}{Array.from({length:rows},(_,i)=><div key={i} aria-hidden="true"><span/><span/></div>)}</div>;
}
