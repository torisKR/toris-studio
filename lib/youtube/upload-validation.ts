import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export class YoutubeUploadError extends Error {
  constructor(readonly code:string, message:string, readonly status:number) {super(message);}
}
const schema=z.object({
  fileName:z.string().min(1).max(255).regex(/^[^\\/\u0000-\u001f]+\.mp4$/i),
  title:z.string().trim().min(1).max(100), description:z.string().max(5000).default(""),
  tags:z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  privacyStatus:z.enum(["private","unlisted","public"]).default("private")
}).strict().refine(value=>!value.tags || value.tags.join(",").length<=500,{message:"태그 길이를 줄여주세요."});
export type YoutubeUploadRequest=z.infer<typeof schema>;

export async function readUploadRequest(request:Request):Promise<YoutubeUploadRequest> {
  if(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json") throw new YoutubeUploadError("INVALID_CONTENT_TYPE","JSON 요청이 필요합니다.",415);
  const limit=32768;
  if(Number(request.headers.get("content-length"))>limit) throw new YoutubeUploadError("REQUEST_TOO_LARGE","업로드 요청이 너무 큽니다.",413);
  const reader=request.body?.getReader();
  if(!reader) throw new YoutubeUploadError("INVALID_INPUT","업로드 정보를 입력하세요.",400);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new YoutubeUploadError("REQUEST_TIMEOUT","요청 수신 시간이 초과되었습니다.",408)),5000);});
  const chunks:Uint8Array[]=[];let bytes=0;
  try {
    while(true){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>limit)throw new YoutubeUploadError("REQUEST_TOO_LARGE","업로드 요청이 너무 큽니다.",413);chunks.push(chunk.value);}
    let value:unknown;
    try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new YoutubeUploadError("INVALID_INPUT","올바른 JSON이 필요합니다.",400);}
    const parsed=schema.safeParse(value);
    if(!parsed.success)throw new YoutubeUploadError("INVALID_INPUT","MP4 파일명, 제목(1~100자), 설명(5000자 이하), 공개 범위를 확인하세요.",400);
    return parsed.data;
  } finally {clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Open once and stream the same validated descriptor, rather than reopening a potentially replaced path. */
export async function openRenderedVideo(filePath:string) {
  const root=path.resolve(process.cwd(),"public/renders");
  const requested=path.resolve(filePath);
  if(path.dirname(requested)!==root || !/^[^\\/\u0000-\u001f]+\.mp4$/i.test(path.basename(requested)))throw new YoutubeUploadError("INVALID_VIDEO_PATH","Studio에서 렌더링한 MP4만 업로드할 수 있습니다.",400);
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    const cwd=await realpath(process.cwd());const actualRoot=await realpath(root);const rootInfo=await lstat(root);
    if(rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !actualRoot.startsWith(cwd+path.sep))throw new Error("unsafe_root");
    const entry=await lstat(requested);
    if(entry.isSymbolicLink() || !entry.isFile())throw new Error("unsafe_entry");
    const actual=await realpath(requested);
    if(path.dirname(actual)!==actualRoot)throw new Error("escaped_root");
    handle=await open(requested,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const info=await handle.stat();
    if(!info.isFile() || info.ino!==entry.ino || info.dev!==entry.dev || info.size<12 || info.size>256*1024**3)throw new Error("invalid_file");
    const header=Buffer.alloc(12);await handle.read(header,0,12,0);
    if(header.toString("ascii",4,8)!=="ftyp" || header.readUInt32BE(0)<12 || header.readUInt32BE(0)>info.size)throw new Error("not_mp4");
    return handle;
  } catch {
    await handle?.close().catch(()=>{});
    throw new YoutubeUploadError("INVALID_VIDEO_FILE","일반 MP4 파일인지 확인하세요. 심볼릭 링크·손상된 헤더·없는 파일은 업로드하지 않습니다.",400);
  }
}

export function uploadFailure(error:unknown):YoutubeUploadError {
  if(error instanceof YoutubeUploadError)return error;
  const value=error && typeof error==="object" ? error as {code?:unknown;response?:{status?:unknown};name?:unknown} : {};
  const status=Number(value.response?.status ?? value.code);
  if(status===401)return new YoutubeUploadError("YOUTUBE_AUTH_REJECTED","YouTube 업로드 인증이 거부되었습니다. 업로드용 OAuth 계정을 다시 연결하세요.",401);
  if(status===403)return new YoutubeUploadError("YOUTUBE_UPLOAD_FORBIDDEN","YouTube 업로드 권한, API 활성화 및 할당량을 확인하세요. 읽기 전용 로그인으로는 게시할 수 없습니다.",403);
  if(status===429)return new YoutubeUploadError("YOUTUBE_RATE_LIMITED","YouTube 요청 한도에 도달했습니다. 잠시 후 채널의 업로드 내역을 확인하세요.",429);
  if(value.code==="ETIMEDOUT" || value.name==="AbortError")return new YoutubeUploadError("YOUTUBE_UPLOAD_TIMEOUT","업로드 응답이 지연되었습니다. 중복 업로드 방지를 위해 다시 시도하기 전에 채널을 확인하세요.",504);
  return new YoutubeUploadError("YOUTUBE_UPLOAD_FAILED","YouTube 업로드 결과를 확인하지 못했습니다. 다시 시도하기 전에 채널의 업로드 내역을 확인하세요.",502);
}
