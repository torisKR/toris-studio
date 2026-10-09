export const STUDIO_TOOLS = ["studio_connection_check","studio_asset_presets","studio_asset_list","studio_asset_request","studio_asset_receive","studio_asset_resize","studio_asset_create_3d","studio_asset_review","studio_asset_job_status","studio_publication_draft_receive"] as const;
function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("설치 앱의 MCP 실행 설정을 확인하세요.");
 return value as Record<string,unknown>;
}
function absolute(raw:string):boolean{
 const drive=/^[a-zA-Z]:[\\/]/.test(raw);
 if((!raw.startsWith("/")&&!drive)||/[\u0000-\u001f\u007f]/.test(raw))return false;
 const parts=(drive?raw.slice(3):raw).split(/[\\/]/);
 return !parts.includes("..")&&parts.some(part=>part!==""&&part!==".");
}
/** Public overlay only. Never reads/replaces Codexify credentials or existing settings. */
export function codexifyOverlay(native:unknown,project:string){
 if(!absolute(project))throw new Error("프로젝트의 절대 경로를 입력하세요. 전체 디스크나 상위 경로는 허용하지 않습니다.");
 const servers=record(record(native).mcpServers);
 const server=Object.values(servers).map(record).find(s=>Array.isArray(s.args)&&s.args.length===1&&s.args[0]==="--studio-mcp");
 if(!server||typeof server.command!=="string"||!absolute(server.command)||!/[\\/]toris-studio-desktop(?:\.exe)?$/.test(server.command))throw new Error("설치된 Studio 실행 파일 경로를 확인하세요.");
 return {workDir:project,agentChat:{enabled:true,port:3120,maxWaitMs:55000},codexMcp:{enabled:false,useCli:false},mcpServers:{studio:{command:server.command,args:["--studio-mcp"],mode:"direct",tools:[...STUDIO_TOOLS],startupTimeoutSec:30,toolTimeoutSec:180}}};
}
export function studioToolInstruction():string {
 return "연결된 실제 도구 목록에서 Studio 도구를 먼저 확인해줘. Codexify direct의 기본 서버명이 studio이면 studio__studio_connection_check, studio__studio_asset_request, studio__studio_asset_receive처럼 접두사가 붙어. 서버명이 다르면 목록의 실제 이름을 사용하고, direct가 아닌 포괄 dispatcher로 파일 수신을 대체하지 마.";
}
export function connectionPrompt(project?:string):string {
 if(project!==undefined&&!absolute(project))throw new Error("프로젝트의 절대 경로를 확인하세요.");
 const selection=project ? `Codexify 작업 프로젝트를 ${project}로 선택해줘.` : "현재 연결된 Codexify 작업 프로젝트를 유지해줘.";
 return [`${selection} 프로젝트 선택은 파일 도구용이며 Studio 에셋의 저장 폴더를 변경하지 마.`,studioToolInstruction(),"studio__studio_connection_check와 studio__studio_asset_presets를 호출해 결과를 확인해줘. 파일 수신 도구의 _meta.openai/fileParams와 file.download_url/file_id 스키마가 그대로 보이는지 확인해줘. 계정 로그인·이미지 생성 성공은 실제 생성·수신 확인 전까지 주장하지 마."].join("\n\n");
}
