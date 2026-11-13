import { useCallback, useEffect, useRef, useState } from "react";
import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { acceptVideoRequest, readVideoResult, refreshNetwork, sendNetworkMessage, sendVideoResult } from "./reason-client";
import type { NetworkSnapshot, VideoResult } from "./types";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

/** Queries on activation; every outbound message and job creation requires an explicit action. */
export function useReasonNetwork(active: boolean, call: BridgeInvoke = nativeInvoke) {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState<Record<string, VideoResult>>({});
  const mounted = useRef(false);
  const refreshingRef = useRef(false);
  const busyRef = useRef(false);
  const refreshSequence = useRef(0);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const next = await refreshNetwork(call);
      if (mounted.current && sequence === refreshSequence.current) setSnapshot(current => {
        // An older query may return after acceptance. Keep the confirmed job link
        // until a later host snapshot supplies it; a host-supplied link takes precedence.
        const confirmed = new Map(current?.messages.filter(message => message.jobId).map(message => [message.id, message.jobId]) ?? []);
        return { ...next, messages: next.messages.map(message => message.jobId || !confirmed.has(message.id)
          ? message : { ...message, jobId: confirmed.get(message.id) ?? null }) };
      });
    } catch (cause) {
      if (mounted.current && sequence === refreshSequence.current) {
        setSnapshot(current => ({ state: "error", version: current?.version ?? null, selfId: current?.selfId ?? null,
          peers: current?.peers ?? [], messages: current?.messages ?? [], error: errorText(cause) }));
      }
    } finally {
      refreshingRef.current = false;
      if (mounted.current && sequence === refreshSequence.current) setRefreshing(false);
    }
  }, [call]);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  const perform = useCallback(async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { return await task(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); return undefined; }
    finally { busyRef.current = false; if (mounted.current) setBusy(""); }
  }, []);

  const send = (target: string, text: string, replyTo?: string) => perform("send", async () => {
    const receipt = await sendNetworkMessage(target, text, replyTo, call);
    if (mounted.current) setNotice("메시지를 전송했습니다. 상대 에이전트의 작업 완료는 받은 답장에서 확인하세요.");
    void refresh();
    return receipt;
  });
  const accept = (messageId: string) => perform("accept:" + messageId, async () => {
    const created = await acceptVideoRequest(messageId, call);
    if (mounted.current) {
      setSnapshot(current => current ? { ...current, messages: current.messages.map(message => message.id === messageId ? { ...message, jobId: created.jobId } : message) } : current);
      setNotice(created.reused ? "이 요청의 기존 영상 작업을 찾았습니다." : "영상 기획을 시작했습니다. 영상 제작 화면에서 스토리보드를 확인하고 승인하세요.");
    }
    return created.jobId;
  });
  const inspect = (messageId: string) => perform("inspect:" + messageId, async () => {
    const result = await readVideoResult(messageId, call);
    if (mounted.current) setResults(current => ({ ...current, [messageId]: result }));
    return result;
  });
  const sendResult = (messageId: string) => perform("result-send:" + messageId, async () => {
    const receipt = await sendVideoResult(messageId, call);
    if (mounted.current) setNotice("영상 작업의 최신 상태 요약을 요청자에게 보냈습니다.");
    return receipt;
  });
  const copy = (text: string) => perform("copy", async () => {
    await call("copy_text", { text });
    if (mounted.current) setNotice("복사했습니다.");
  });
  return { snapshot, refreshing, busy, error, notice, results, refresh, send, accept, inspect, sendResult, copy };
}
