import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodexifyPanel } from "./CodexifyPanel";

type CodingMetadata = { mcpConfig: object; mcp: { lastFileReceivedAt: string | null } };

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
  return <div aria-label="코딩 작업실"><CodexifyPanel active={active} refreshKey={refreshKey} nativeMcpConfig={metadata?.mcpConfig} lastFileReceivedAt={metadata?.mcp.lastFileReceivedAt}/></div>;
}
