import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileVideo, KeyRound, RefreshCw, Send, ShieldCheck } from "lucide-react";
import "./IntegrationPanel.css";
import { ActivityStatus } from "./ActivityStatus";
type Provider={platform:string;clientConfigured:boolean;connected:boolean;uploadAuthorized?:boolean;pending:boolean};
type UploadRecord={attemptId:string;status:string;title:string;channelTitle:string;requestedPrivacy:string;actualPrivacy?:string;url?:string;error?:string};
type Status={oauth:{providers:Provider[]};mcp:{lastToolCallAt:string|null;lastFileReceivedAt:string|null;chatgptLoginVerified:boolean};mcpConfig:object;lastUpload:UploadRecord|null;version:string};
type FileSelection={fileId:string;fileName:string;bytes:number;sha256:string;cancelled?:boolean};
type Ticket={ticketId:string;channelTitle:string;channelId:string;title:string;description:string;privacy:string;fileName:string;bytes:number;sha256:string};
const privacyLabels:Record<string,string>={private:"비공개",unlisted:"일부 공개",public:"공개"};
function failure(e:unknown){return typeof e==="string"?e:e instanceof Error?e.message:"요청을 처리하지 못했습니다.";}
export function IntegrationPanel({active,onOAuth,onCoding,refreshKey=0}:{active:boolean;onOAuth:()=>void;onCoding:()=>void;refreshKey?:number}) {
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState("");
  const [channels,setChannels]=useState<Array<{id:string;title:string}>>([]),[channelId,setChannelId]=useState(""),[file,setFile]=useState<FileSelection|null>(null);
  const [title,setTitle]=useState("[Toris Studio QA] 업로드 연결 테스트"),[description,setDescription]=useState("Toris Studio의 업로드 연결을 확인하기 위한 테스트 영상입니다. 실제 서비스 콘텐츠가 아닙니다.");
  const [privacy,setPrivacy]=useState("private"),[confirmPublic,setConfirmPublic]=useState(false),[madeForKids,setMadeForKids]=useState("false"),[confirmed,setConfirmed]=useState(false),[ticket,setTicket]=useState<Ticket|null>(null);
  const gate=useRef(false),reading=useRef(false);
  const refresh=useCallback(async()=>{
    if(reading.current)return;reading.current=true;
    try{setStatus(await invoke<Status>("integration_status"));}catch(e){setError(failure(e));}finally{reading.current=false;}
  },[]);
  useEffect(()=>{if(!active)return;void refresh();const id=setInterval(()=>{if(document.visibilityState==="visible"&&!gate.current)void refresh();},10000);return()=>clearInterval(id);},[active,refresh,refreshKey]);
  const youtube=status?.oauth.providers.find(p=>p.platform==="youtube");
  function invalidate(){setTicket(null);setConfirmed(false);}
  async function run(label:string,work:()=>Promise<void>){
    if(gate.current)return;gate.current=true;setBusy(label);setError("");setNotice("");
    try{await work();}catch(e){setError(failure(e));}finally{gate.current=false;setBusy("");}
  }
  async function open(url:string){await invoke("open_external",{url});}
  async function choose(sample=false){const selected=await invoke<FileSelection>(sample?"integration_sample_video":"integration_choose_video");if(!selected.cancelled){setFile(selected);invalidate();}}
  async function prepare(){if(!file)throw new Error("테스트 영상을 선택하거나 만들어 주세요.");invalidate();setTicket(await invoke<Ticket>("integration_prepare_upload",{input:{platform:"youtube",channelId,fileId:file.fileId,title,description,privacy,confirmPublic,madeForKids:madeForKids==="true"}}));setNotice("전송 준비가 끝났습니다. 아직 업로드하지 않았습니다. 아래 내용을 확인하세요.");}
  async function upload(){if(!ticket||!confirmed)return;const id=ticket.ticketId;setTicket(null);setConfirmed(false);const record=await invoke<UploadRecord>("integration_upload",{ticketId:id,confirmed:true});await refresh();setNotice(`YouTube가 영상 저장을 확인했습니다. 실제 공개 범위: ${privacyLabels[record.actualPrivacy??""]??"확인 필요"}. 영상 처리 완료는 YouTube Studio에서 확인하세요.`);}
  if(!active)return null;
  return <section className="integration-panel" aria-label="연결 및 게시 QA" aria-busy={Boolean(busy)}>
    <div className="integration-toolbar"><p>계정 인증, 도구 연결, 파일 수신, 게시 결과를 각각 확인합니다.</p><button className="social-button" disabled={Boolean(busy)} onClick={()=>void run("연결 확인",refresh)}><RefreshCw size={16}/>상태 새로고침</button></div>
    {error&&<div className="social-notice error" role="alert">{error}</div>}{notice&&<div className="social-notice success" role="status">{notice}</div>}{busy&&<ActivityStatus title={`${busy} 중`} detail="작업이 진행 중입니다. 전송 완료 여부는 실제 응답으로 확인합니다. 업로드 중에는 앱을 닫거나 동일한 작업을 다시 요청하지 마세요."/>}{!status&&!error&&!busy&&<ActivityStatus title="연결 상태 확인 중"/>}
    <div className="social-notice info"><span>Codexify와 ChatGPT 대화 연결은 코딩에서 관리합니다.</span><button className="social-button compact" onClick={onCoding}>코딩 열기</button></div>
    <div className="integration-layout">
      <div className="integration-connections">
        <section className="integration-section"><h2>YouTube 업로드 계정</h2><p>기존 SNS 읽기 로그인과 업로드 승인은 구분됩니다. 추가 권한은 시스템 브라우저에서 직접 승인합니다.</p><div className="integration-state"><ShieldCheck size={18}/><strong>{youtube?.uploadAuthorized?"업로드 권한 확인됨":youtube?.pending?"브라우저 로그인 대기":youtube?.connected?"읽기 연결됨 · 업로드 승인 필요":youtube?.clientConfigured?"업로드 로그인 필요":"OAuth 앱 설정 필요"}</strong></div>
          <div className="integration-actions"><button className="social-button" disabled={Boolean(busy)} onClick={onOAuth}><KeyRound size={16}/>OAuth 앱 설정</button><button className="social-button primary" disabled={!youtube?.clientConfigured||Boolean(busy)} onClick={()=>void run("업로드 권한 로그인",async()=>{invalidate();setChannels([]);setChannelId("");await invoke("integration_upload_login");setNotice("시스템 브라우저에서 YouTube 업로드 권한을 승인하세요. 기존 세션은 새 인증이 성공할 때 갱신됩니다.");await refresh();})}>업로드 권한 승인</button></div>
          <p className="integration-note">인증은 기본 브라우저의 계정으로 진행됩니다. 사용할 채널이 보이지 않으면 해당 채널 계정을 선택해 다시 승인하세요.</p>
        </section>
      </div>
      <div>
        <form className="integration-publish" onSubmit={e=>{e.preventDefault();void run("게시 사전 확인",prepare);}}>
          <h2>게시 QA</h2><p>테스트 파일과 채널을 고른 뒤 확인 화면에서 전송합니다. 기본값은 비공개이며 구독자 알림을 보내지 않습니다.</p>
          <fieldset disabled={Boolean(busy)}><label>플랫폼<select aria-label="QA 플랫폼" value="youtube" disabled><option value="youtube">YouTube · 영상</option></select></label><p className="integration-note">Threads·Instagram·TikTok·네이버의 외부 게시 어댑터는 아직 제공하지 않습니다. 이 화면에서 게시한 것처럼 기록하지 않습니다.</p>
          <div className="integration-channel"><label>대상 채널<select aria-label="QA 대상 채널" value={channelId} required onChange={e=>{setChannelId(e.target.value);invalidate();}}><option value="">인증된 채널을 조회해 선택하세요</option>{channels.map(c=><option key={c.id} value={c.id}>{c.title} · {c.id}</option>)}</select></label><button type="button" className="social-button" disabled={!youtube?.uploadAuthorized} onClick={()=>void run("인증 채널 조회",async()=>{invalidate();const data=await invoke<{channels:Array<{id:string;title:string}>}>("integration_channels");setChannels(data.channels);setChannelId("");if(!data.channels.length)throw new Error("이 계정에는 조회 가능한 YouTube 채널이 없습니다.");})}>채널 조회</button></div>
          <div className="integration-file"><FileVideo size={23}/><div><strong>{file?.fileName??"테스트 영상 미선택"}</strong><p>{file?`${(file.bytes/1024/1024).toFixed(2)} MiB · 선택한 파일의 복사본으로 전송` : "MP4 · 최대 64 MiB · 원본은 수정하지 않음"}</p></div></div>
          <div className="integration-actions"><button type="button" className="social-button" onClick={()=>void run("영상 선택",()=>choose())}>MP4 선택</button><button type="button" className="social-button" onClick={()=>void run("3초 테스트 영상 생성",()=>choose(true))}>3초 QA 영상 만들기</button></div><p className="integration-note">테스트 영상 만들기는 로컬 FFmpeg가 필요하며 업로드·게시를 실행하지 않습니다.</p>
          <label>게시 제목<input aria-label="QA 게시 제목" maxLength={100} required value={title} onChange={e=>{setTitle(e.target.value);invalidate();}}/></label><label>설명·테스트 문구<textarea aria-label="QA 게시 설명" rows={4} maxLength={5000} value={description} onChange={e=>{setDescription(e.target.value);invalidate();}}/></label>
          <div className="integration-pair"><label>공개 범위<select aria-label="QA 공개 범위" value={privacy} onChange={e=>{setPrivacy(e.target.value);setConfirmPublic(false);invalidate();}}><option value="private">비공개</option><option value="unlisted">일부 공개</option><option value="public">공개</option></select></label><label>아동용 콘텐츠<select aria-label="QA 아동용 여부" value={madeForKids} onChange={e=>{setMadeForKids(e.target.value);invalidate();}}><option value="false">아동용 아님</option><option value="true">아동용</option></select></label></div>
          {privacy!=="private"&&<label className="integration-checkbox"><input type="checkbox" checked={confirmPublic} onChange={e=>{setConfirmPublic(e.target.checked);invalidate();}}/>이 테스트 영상이 다른 사람에게 노출될 수 있음을 확인했습니다.</label>}
          <button className="social-button primary" type="submit" disabled={!youtube?.uploadAuthorized||!file||!channelId||(privacy!=="private"&&!confirmPublic)}><Check size={16}/>게시 준비 · 아직 전송하지 않음</button>
          </fieldset>
        </form>
        {ticket&&<section className="integration-confirm" aria-label="최종 전송 확인"><h3>최종 전송 확인</h3><dl className="integration-facts"><dt>채널</dt><dd>{ticket.channelTitle}</dd><dt>영상</dt><dd>{ticket.fileName}</dd><dt>제목</dt><dd>{ticket.title}</dd><dt>공개 범위</dt><dd>{privacyLabels[ticket.privacy]}</dd></dl><label className="integration-checkbox"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={e=>setConfirmed(e.target.checked)}/>위 계정과 파일을 확인했고 실제 YouTube 전송에 동의합니다.</label><button className="social-button primary" disabled={!confirmed||Boolean(busy)} onClick={()=>void run("YouTube 영상 전송",upload)}><Send size={16}/>{privacyLabels[ticket.privacy]}로 실제 전송</button><p className="integration-note">확인은 10분·1회만 유효합니다. 전송 중에는 창을 닫지 마세요.</p></section>}
        {status?.lastUpload&&<section className="integration-last" aria-label="최근 게시 결과"><h3>최근 전송 결과</h3><strong>{status.lastUpload.title}</strong><p>{status.lastUpload.status==="uploaded"?`YouTube 저장 확인 · 실제 ${privacyLabels[status.lastUpload.actualPrivacy??""]??"공개 범위 미확인"}`:status.lastUpload.status==="acknowledged"?"사용자가 YouTube Studio에서 결과 확인 완료":"전송 결과 확인 필요 · 자동 재시도하지 않음"}</p>{status.lastUpload.error&&<p>{status.lastUpload.error}</p>}<button className="social-button compact" onClick={()=>void run("YouTube Studio 열기",()=>open("https://studio.youtube.com/"))}>YouTube Studio에서 확인</button>{["sending","uncertain"].includes(status.lastUpload.status)&&<button className="social-button compact" disabled={Boolean(busy)} onClick={()=>void run("결과 확인 기록",async()=>{await invoke("integration_acknowledge_upload",{attemptId:status.lastUpload!.attemptId});await refresh();})}>전송 결과 확인 완료</button>}</section>}
      </div>
    </div>
  </section>;
}
