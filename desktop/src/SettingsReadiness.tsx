import { invoke } from "@tauri-apps/api/core";
import { Check, CircleAlert, ListChecks, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { aiStatus, contentReady } from "./ai-client";

export type ReadinessInput = { database: boolean; contentModel: boolean; image: boolean; youtubeKey: boolean; youtubeLogin: boolean; naverKey: boolean; naverBroker: boolean; snsConnections: number };
export type Fix = "start_database" | "open_agent" | "open_settings_keys" | "open_sns";
export type ReadinessRow = { id: string; feature: string; ready: boolean; missing: string; fix: Fix | null };
const FIX_LABELS: Record<Fix, string> = { start_database: "DB 시작", open_agent: "모델 설정 열기", open_settings_keys: "키 입력으로 이동", open_sns: "SNS 연결 열기" };

/** Fixed map from features to what they need. Alternatives count: a YouTube login for the key, the Toris broker for the Naver key. */
export function readiness(input: ReadinessInput): ReadinessRow[] {
  const row = (id: string, feature: string, ready: boolean, missing: string, fix: Fix): ReadinessRow => ({ id, feature, ready, missing: ready ? "" : missing, fix: ready ? null : fix });
  return [
    row("ai-writing", "문구·영상 초안·주간 콘텐츠 (AI)", input.contentModel, "콘텐츠 작성 모델 (로그인된 구독 CLI 또는 API 키)", "open_agent"),
    row("image", "AI 이미지 생성", input.image, "이미지 생성 모델과 OpenAI·Gemini API 키", "open_agent"),
    row("database", "채널·콘텐츠·일정 저장 (로컬 DB)", input.database, "로컬 DB 컨테이너 (OrbStack·Docker)", "start_database"),
    row("youtube", "트렌드·채널 조회 (YouTube)", input.youtubeKey || input.youtubeLogin, "YouTube Data API 키 또는 YouTube 계정 연결", "open_sns"),
    row("naver", "트렌드 (네이버 블로그 검색)", input.naverKey || input.naverBroker, "네이버 검색 API 키 (Toris 연결로는 아직 검색할 수 없습니다)", "open_settings_keys"),
    row("sns", "SNS 분석·게시", input.snsConnections > 0 && input.database, input.database ? "SNS 계정 로그인" : "로컬 DB와 SNS 계정 로그인", input.database ? "open_sns" : "start_database"),
  ];
}

type Providers = { providers?: Array<{ platform: string; connected?: boolean; connectionCount?: number }> };
/** Reads existing status commands only; any failure counts as "not ready", never as an error screen. */
async function loadInput(databaseConnected: boolean): Promise<ReadinessInput> {
  const [ai, settings, oauth, broker] = await Promise.allSettled([
    aiStatus(),
    invoke<{ youtubeConfigured?: boolean; naverConfigured?: boolean }>("get_settings"),
    invoke<Providers>("oauth_status"),
    invoke<{ naverSearch?: boolean }>("oauth_connection_dispatch", { input: { action: "brokerConfig" } }),
  ]);
  const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
  const model = ok(ai), keys = ok(settings), providers = ok(oauth)?.providers ?? [];
  const image = model?.image;
  return {
    database: databaseConnected,
    contentModel: contentReady(model),
    image: Boolean(image && model?.providers.find(p => p.id === image.provider)?.available),
    youtubeKey: Boolean(keys?.youtubeConfigured),
    youtubeLogin: Boolean(providers.find(p => p.platform === "youtube")?.connected),
    naverKey: Boolean(keys?.naverConfigured),
    naverBroker: ok(broker)?.naverSearch === true,
    snsConnections: providers.filter(p => p.platform !== "google_calendar").reduce((sum, p) => sum + (p.connectionCount ?? (p.connected ? 1 : 0)), 0),
  };
}

export function SettingsReadiness({ databaseConnected, onFix }: { databaseConnected: boolean; onFix: (fix: Fix) => void }) {
  const [rows, setRows] = useState<ReadinessRow[] | null>(null);
  const load = useCallback(() => { void loadInput(databaseConnected).then(input => setRows(readiness(input))); }, [databaseConnected]);
  useEffect(() => { load(); }, [load]);
  return <section className="desktop-settings-section settings-readiness" aria-labelledby="settings-readiness-title">
    <h2 id="settings-readiness-title"><ListChecks size={18} />준비 상태</h2>
    <p>기능마다 필요한 것과 지금 빠진 것입니다. 빠진 항목의 버튼을 누르면 고치는 곳으로 이동합니다.</p>
    {!rows ? <p className="settings-readiness-loading" role="status"><LoaderCircle size={14} className="social-spin" />준비 상태 확인 중</p> : <ul className="settings-readiness-list">
      {rows.map(r => <li key={r.id} data-ready={r.ready || undefined}>
        {r.ready ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <div><strong>{r.feature}</strong><span>{r.ready ? "준비됨" : "필요: " + r.missing}</span></div>
        {r.fix && <button type="button" className="social-button compact" onClick={() => onFix(r.fix!)}>{FIX_LABELS[r.fix]}</button>}
      </li>)}
    </ul>}
  </section>;
}
