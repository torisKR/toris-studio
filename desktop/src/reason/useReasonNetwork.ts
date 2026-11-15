import { useCallback, useEffect, useRef, useState } from "react";
import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import { acceptVideoRequest, readVideoResult, refreshNetwork, sendNetworkMessage, sendVideoResult } from "./reason-client";
import { createSnsHandoff, importSnsRequest, sendSnsResult, type SnsImportInput } from "./sns-client";
import type { HostedAssistant, NetworkSnapshot, SnsHandoff, SnsPlatform, VideoResult } from "./types";

const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);

/** Queries on activation; every outbound message and job creation requires an explicit action. */
export function useReasonNetwork(active: boolean, call: BridgeInvoke = nativeInvoke) {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState<Record<string, VideoResult>>({});
  const [handoff, setHandoff] = useState<SnsHandoff | null>(null);
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
  const importSns = (input: SnsImportInput) => perform("sns-import:" + input.messageId, async () => {
    const result = await importSnsRequest(input, call);
    if (mounted.current) {
      setSnapshot(current => current ? { ...current, messages: current.messages.map(message => message.id === input.messageId ? { ...message, snsImport: result.import } : message) } : current);
      setNotice((result.reused ? "이 기획은 이미 가져왔습니다. " : "SNS 콘텐츠 초안과 발행 계획 초안으로 저장했습니다. ") + "게시는 발행 화면에서 계정을 고르고 승인해야 합니다." + (result.warning ? " (" + result.warning + ")" : ""));
    }
    return result;
  });
  const sendSns = (messageId: string) => perform("sns-result:" + messageId, async () => {
    const receipt = await sendSnsResult(messageId, call);
    if (mounted.current) setNotice("SNS 기획 가져오기 결과를 요청자에게 보냈습니다.");
    return receipt;
  });
  const createHandoff = (assistant: HostedAssistant, brief: string, platforms: SnsPlatform[]) => perform("sns-handoff", async () => {
    const created = await createSnsHandoff(assistant, brief, platforms, call);
    if (mounted.current) { setHandoff(created); setNotice(created.assistant + "에게 붙여넣을 전달문을 만들었습니다. 복사해서 그 앱에 붙여넣으세요."); }
    return created;
  });
  const copy = (text: string) => perform("copy", async () => {
    await call("copy_text", { text });
    if (mounted.current) setNotice("복사했습니다.");
  });
  return { snapshot, refreshing, busy, error, notice, results, handoff, refresh, send, accept, inspect, sendResult, importSns, sendSns, createHandoff, copy };
}
