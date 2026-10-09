import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodexifyPanel } from "./CodexifyPanel";

type CodingMetadata = { mcpConfig: object; mcp: { lastFileReceivedAt: string | null; lastToolCallAt: string | null } };

export function CodingPanel({ active, refreshKey = 0 }: { active: boolean; refreshKey?: number }) {
  const [metadata, setMetadata] = useState<CodingMetadata | null>(null);
  const alive = useRef(false), epoch = useRef(0);
  const load = useCallback(async () => {
    const generation = ++epoch.current;
    try {
      const value = await invoke<CodingMetadata>("integration_status");
      if (alive.current && generation === epoch.current) setMetadata(value);
    } catch { if (alive.current && generation === epoch.current) setMetadata(null); }
  }, []);
  useEffect(() => {
    if (!active) return;
    alive.current = true; void load();
    return () => { alive.current = false; ++epoch.current; };
  }, [active, refreshKey, load]);
  if (!active) return null;
  return <div aria-label="코딩 작업실"><section className="social-notice info" aria-label="ChatGPT 전용 연결"><p><strong>실제 ChatGPT 대화로 작업합니다.</strong> 아래에서 연결된 대화를 열어 시작·재개하세요. 요청 저장, ChatGPT 수신, 응답, 파일 수신을 각각 확인할 수 있습니다. 앱에서 메시지를 저장해도 종료된 ChatGPT 대화가 자동으로 시작되지는 않습니다.</p></section><CodexifyPanel active={active} refreshKey={refreshKey} nativeMcpConfig={metadata?.mcpConfig} lastFileReceivedAt={metadata?.mcp.lastFileReceivedAt} lastToolCallAt={metadata?.mcp.lastToolCallAt} onIntegrationRefresh={load}/></div>;
}
