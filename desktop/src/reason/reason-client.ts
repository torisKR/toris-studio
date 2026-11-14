import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import type { ProductionInput } from "../production/production-client";
import type { NetworkSnapshot, NetworkState, ReasonMessage, ReasonPeer, SendReceipt, StoryboardPreview, VideoRequest, VideoResult } from "./types";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const nullable = (value: unknown) => typeof value === "string" && value ? value : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const states: NetworkState[] = ["missing", "setup_required", "connected", "error"];
const id = (value: string, label: string) => {
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\x00-\x1f\x7f]/.test(clean)) throw new Error(label + "을 확인하세요.");
  return clean;
};
export function singleTarget(value: string): string {
  const target = id(value, "받는 에이전트");
  if (target.includes("*") || target.startsWith("repo:")) throw new Error("한 에이전트만 선택하세요. 전체 전송은 지원하지 않습니다.");
  return target;
}

/** Display data only. The native host keeps and validates the full storyboard. */
function storyboardPreview(value: unknown): StoryboardPreview | null {
  const board = rec(value), scenes = array(board.scenes);
  if (!str(board.title).trim() || scenes.length < 2 || scenes.length > 12) return null;
  const ids = new Set<string>();
  const preview: StoryboardPreview["scenes"] = [];
  for (const value of scenes) {
    const scene = rec(value), sceneId = str(scene.id);
    if (!sceneId || ids.has(sceneId) || typeof scene.durationSec !== "number" || !Number.isFinite(scene.durationSec) || scene.durationSec < 2 || scene.durationSec > 12) return null;
    ids.add(sceneId);
    preview.push({ id: sceneId, durationSec: scene.durationSec, script: str(scene.script), narration: str(scene.narration), caption: str(scene.caption) });
  }
  return { title: str(board.title), story: str(board.story), scenes: preview };
}

/** Preview only. Rust independently validates the closed request before creating a job. */
function videoRequest(value: unknown): VideoRequest | null {
  const r = rec(value), s = rec(r.settings);
  const storyboard = r.storyboard == null ? null : storyboardPreview(r.storyboard);
  if (r.storyboard != null && !storyboard) return null;
  if (r.schema !== "toris-studio.video.v1" || !str(r.requestId).trim() || !str(s.topic).trim()) return null;
  if (!Number.isInteger(s.durationSec) || Number(s.durationSec) < 10 || Number(s.durationSec) > 120 || typeof s.narration !== "boolean") return null;
  const allowed = {
    aspect: ["9:16", "16:9", "1:1"], style: ["realistic", "cinematic", "animation", "documentary"],
    subtitleStyle: ["shorts-bold", "clean-bottom", "none"], bgm: ["none", "ambient", "pulse"],
    quality: ["preview", "standard", "high"], visual: ["stock", "ai"], layout: ["card", "full"]
  };
  if (Object.entries(allowed).some(([key, values]) => !values.includes(str(s[key]))) || typeof s.engine !== "string") return null;
  return { schema: "toris-studio.video.v1", requestId: str(r.requestId), settings: {
    topic: str(s.topic), durationSec: Number(s.durationSec), narration: s.narration, engine: s.engine,
    aspect: s.aspect as ProductionInput["aspect"], style: s.style as ProductionInput["style"],
    subtitleStyle: s.subtitleStyle as ProductionInput["subtitleStyle"], bgm: s.bgm as ProductionInput["bgm"],
    quality: s.quality as ProductionInput["quality"], visual: s.visual as ProductionInput["visual"], layout: s.layout as ProductionInput["layout"],
    ...(typeof s.speaker === "string" ? { speaker: s.speaker } : {})
  }, ...(storyboard ? { storyboard } : {}) };
}
function peer(value: unknown): ReasonPeer | null {
  const r = rec(value);
  try { singleTarget(str(r.id)); } catch { return null; }
  return { id: str(r.id), name: str(r.name) || str(r.id), kind: str(r.kind) || "agent", machine: nullable(r.machine), cwd: nullable(r.cwd), branch: nullable(r.branch), busy: r.busy === true };
}
function message(value: unknown): ReasonMessage | null {
  const r = rec(value);
  if (!str(r.id) || !str(r.from)) return null;
  const video = videoRequest(r.video);
  return {
    id: str(r.id), from: str(r.from), fromName: nullable(r.fromName), text: str(r.text), createdAt: nullable(r.createdAt), replyTo: nullable(r.replyTo),
    video, requestError: nullable(r.requestError) ?? (r.video && !video ? "영상 요청 형식을 읽지 못했습니다. 요청 예시의 형식으로 다시 보내 주세요." : null), jobId: nullable(r.jobId)
  };
}
export function normalizeSnapshot(value: unknown): NetworkSnapshot {
  const r = rec(value), valid = states.includes(r.state as NetworkState);
  const peers = array(r.peers).map(peer).filter((p): p is ReasonPeer => !!p);
  const messages = array(r.messages).map(message).filter((m): m is ReasonMessage => !!m);
  return {
    state: valid ? r.state as NetworkState : "error", version: nullable(r.version), selfId: nullable(r.selfId),
    peers: [...new Map(peers.map(p => [p.id, p])).values()], messages: [...new Map(messages.map(m => [m.id, m])).values()],
    error: nullable(r.error) ?? (valid ? null : "이 앱에서 Reason 연결 상태를 읽지 못했습니다. 앱을 업데이트하거나 다시 확인하세요.")
  };
}
function receipt(value: unknown): SendReceipt {
  const ids = array(rec(value).messageIds).filter((v): v is string => typeof v === "string" && !!v);
  if (!ids.length) throw new Error("전송 결과를 확인하지 못했습니다. 중복 전송 전에 받은 편지함을 확인하세요.");
  return { messageIds: ids };
}
export function normalizeResult(value: unknown): VideoResult {
  const r = rec(value);
  if (!str(r.jobId) || !str(r.status) || !str(r.summary)) throw new Error("영상 작업 결과를 읽지 못했습니다.");
  return { jobId: str(r.jobId), status: str(r.status), stage: str(r.stage), title: str(r.title), hasVideo: r.hasVideo === true, requiresApproval: r.requiresApproval === true, summary: str(r.summary) };
}
export async function refreshNetwork(call: BridgeInvoke = nativeInvoke): Promise<NetworkSnapshot> {
  return normalizeSnapshot(await call("reason_network_refresh"));
}
export async function sendNetworkMessage(target: string, text: string, replyTo?: string, call: BridgeInvoke = nativeInvoke): Promise<SendReceipt> {
  const body = text.trim();
  if (!body || body.length > 16000) throw new Error("메시지는 1~16,000자로 입력하세요.");
  const input = { target: singleTarget(target), text: body, ...(replyTo ? { replyTo: id(replyTo, "답장할 메시지") } : {}) };
  return receipt(await call("reason_network_send", { input }));
}
export async function acceptVideoRequest(messageId: string, call: BridgeInvoke = nativeInvoke): Promise<{ jobId: string; reused: boolean }> {
  const result = rec(await call("reason_network_accept_video", { input: { messageId: id(messageId, "메시지") } }));
  if (!str(result.jobId)) throw new Error("만들어진 영상 작업을 확인하지 못했습니다. 받은 요청을 새로고침하세요.");
  return { jobId: str(result.jobId), reused: result.reused === true };
}
export async function readVideoResult(messageId: string, call: BridgeInvoke = nativeInvoke): Promise<VideoResult> {
  return normalizeResult(await call("reason_network_video_result", { input: { messageId: id(messageId, "메시지") } }));
}
export async function sendVideoResult(messageId: string, call: BridgeInvoke = nativeInvoke): Promise<SendReceipt> {
  return receipt(await call("reason_network_send_result", { input: { messageId: id(messageId, "메시지") } }));
}
export const VIDEO_REQUEST_EXAMPLE = JSON.stringify({
  schema: "toris-studio.video.v1", requestId: "video-demo-001",
  settings: { topic: "Toris Studio로 쇼츠를 만드는 과정", durationSec: 30, aspect: "9:16", style: "documentary", narration: true, speaker: "Sohee",
    subtitleStyle: "shorts-bold", bgm: "pulse", quality: "preview", engine: "", visual: "stock", layout: "card" }
}, null, 2);

export const STORYBOARD_REQUEST_EXAMPLE = JSON.stringify({
  ...JSON.parse(VIDEO_REQUEST_EXAMPLE), requestId: "video-storyboard-001",
  storyboard: {
    title: "단월 업데이트, 달라진 세 가지",
    story: "새로운 장비와 성장 경험을 소개하는 30초 쇼츠",
    headline: { top: "단월 업데이트", bottom: "달라진 세 가지" },
    scenes: [
      { id: "intro", durationSec: 10, script: "업데이트 핵심 소개", narration: "단월의 새로운 업데이트를 소개합니다.", caption: "새로운 시작", search: "moon mountain", transition: "fade" },
      { id: "equipment", durationSec: 10, script: "장비와 성장 소개", narration: "다양한 장비를 모으며 나만의 캐릭터를 성장시켜 보세요.", caption: "장비와 성장", search: "fantasy sword", transition: "cut" },
      { id: "outro", durationSec: 10, script: "업데이트 확인 안내", narration: "자세한 변경 사항은 게임에서 확인해 주세요.", caption: "단월에서 확인하세요", search: "mountain sunrise", transition: "fade" }
    ]
  }
}, null, 2);
