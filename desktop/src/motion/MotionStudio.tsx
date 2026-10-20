import { Channel, invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Play, Save, Plus, Undo2, Redo2, Copy, Trash2, Sparkles, Download, RefreshCw } from 'lucide-react';
import { getProfile, sendToConnectedChat, openConnectedChat } from '../codexify-client';
import { openRenderPreview } from '../native-windows';
import type { VideoRenderProgressMessage } from '../video-render-progress';
import { remoteDesktopPrompt, canApplyReview, editingKey, history, pushHistory, undoHistory, redoHistory, newMotionProject, newMotionScene, duplicateElement, element, parseTable, dimensions, changeFormat, templateKinds, templateLabels, type MotionProject, type MotionScene, type MotionRequest, type MotionImage, type ElementKind, type GraphicElement, type TemplateKind } from './model';
import './MotionStudio.css';
type Frame = {
    dataUrl: string;
    hash: string;
};
type Output = {
    path: string;
    durationSec: number;
    hash: string;
};
const key = editingKey;
const error = (e: unknown) => e instanceof Error ? e.message : String(e);
const storage = 'toris-studio-motion-editor-v1';
function restore() { try {
    const saved = JSON.parse(localStorage.getItem(storage) || 'null');
    if (saved?.project?.motionGraphics?.version === 1 && saved.project.scenes?.length)
        return saved as {
            project: MotionProject;
            baseline: string;
        };
}
catch { } return null; }
const kinds: ElementKind[] = ['text', 'rectangle', 'circle', 'line', 'image', 'bar', 'chart-line', 'donut'];
const labels: Record<ElementKind, string> = { text: '텍스트', rectangle: '사각형', circle: '원', line: '선', image: '이미지', bar: '막대 차트', 'chart-line': '선 차트', donut: '도넛 차트' };
export function MotionStudio({ active }: {
    active: boolean;
}) {
    const [initial] = useState(restore);
    const [h, setH] = useState(() => history(initial?.project ?? newMotionProject()));
    const p = h.present;
    const [baseline, setBaseline] = useState(initial?.baseline ?? '');
    const [projects, setProjects] = useState<MotionProject[]>([]);
    const [sceneId, setSceneId] = useState(p.scenes[0].id);
    const [elementId, setElementId] = useState('');
    const [time, setTime] = useState(2);
    const [frame, setFrame] = useState<Frame | null>(null);
    const [previewError, setPreviewError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');
    const [allowDataEdits, setAllowDataEdits] = useState(false);
    const [delivery, setDelivery] = useState<'remote-desktop' | 'codexify'>('remote-desktop');
    const [requestMode, setRequestMode] = useState<'create' | 'edit'>('create');
    const [instruction, setInstruction] = useState('');
    const [csv, setCsv] = useState('label,value\nQ1,12\nQ2,15\nQ3,18\nQ4,24');
    const [request, setRequest] = useState<MotionRequest | null>(null);
    const [review, setReview] = useState<{
        before: Frame | null;
        after: Frame | null;
        project: MotionProject;
        key: string;
        requestId: string;
        sceneId: string;
    } | null>(null);
    const [output, setOutput] = useState<Output | null>(null);
    const [outputKey, setOutputKey] = useState('');
    const [template, setTemplate] = useState<TemplateKind>('title');
    const [addKind, setAddKind] = useState<ElementKind>('text');
    const [scope, setScope] = useState<'all' | 'scene' | 'element'>('all');
    const pRef = useRef(p);
    pRef.current = p;
    const busyRef = useRef(false);
    const sequence = useRef(0);
    const drag = useRef<{
        base: MotionProject;
        id: string;
        x: number;
        y: number;
        rect: DOMRect;
        resize: boolean;
    } | null>(null);
    const stage = useRef<HTMLDivElement>(null);
    const dirty = key(p) !== baseline;
    const selected = p.scenes.find(s => s.id === sceneId) ?? p.scenes[0];
    const index = p.scenes.indexOf(selected);
    const e = selected.graphics.elements.find(e => e.id === elementId);
    const [w, height] = dimensions(p);
    const total = p.scenes.reduce((a, s) => a + s.durationSec, 0);
    const conflicted = !!request && key(request.project) !== key(p);
    const rendered = outputKey === key(p);
    const handoff = delivery === 'remote-desktop' && request?.mcpExecutable ? remoteDesktopPrompt(request) : '';
    function commit(next: MotionProject) { setH(current => pushHistory(current, next)); setReview(null); }
    function mutate(edit: (next: MotionProject) => void) { const next = structuredClone(pRef.current); edit(next); commit(next); }
    function updateElement(patch: Partial<GraphicElement>) { mutate(n => { const el = n.scenes.find(s => s.id === selected.id)?.graphics.elements.find(el => el.id === elementId); if (el)
        Object.assign(el, patch); }); }
    async function run(name: string, work: () => Promise<void>) { if (busyRef.current)
        return; busyRef.current = true; setBusy(name); setNotice(''); try {
        await work();
    }
    catch (e) {
        setNotice(error(e));
    }
    finally {
        setBusy('');
        busyRef.current = false;
    } }
    async function load() { const all = await invoke<MotionProject[]>('video_list_projects'); setProjects(all.filter(p => p.motionGraphics?.version === 1)); }
    useEffect(() => { void load().catch(e => setNotice(error(e))); }, []);
    useEffect(() => { const id = window.setTimeout(() => { try {
        localStorage.setItem(storage, JSON.stringify({ project: p, baseline }));
    }
    catch {
        setNotice('편집 복구본을 저장하지 못했습니다. 프로젝트 저장을 실행하세요.');
    } }, 300); return () => clearTimeout(id); }, [p, baseline]);
    useEffect(() => { if (!active)
        return; let cancelled = false; async function poll() { try {
        const all = await invoke<MotionRequest[]>('motion_request_list');
        if (!cancelled) {
            const latest = all.filter(r => r.projectId === p.id && ['waiting', 'received'].includes(r.status)).at(-1);
            setRequest(latest ?? null);
        }
    }
    catch (e) {
        if (!cancelled)
            setNotice(error(e));
    } } void poll(); const timer = setInterval(() => void poll(), 4000); return () => { cancelled = true; clearInterval(timer); }; }, [active, p.id]);
    useEffect(() => { if (!active)
        return; let cancelled = false; const take = ++sequence.current; setFrame(null); setPreviewError(''); let timer: ReturnType<typeof setTimeout>; async function update() { if (cancelled)
        return; try {
        const value = await invoke<Frame>('motion_preview', { project: p, index, time: Math.min(time, selected.durationSec - 1 / 24) });
        if (!cancelled && take === sequence.current)
            setFrame(value);
    }
    catch (e) {
        if (cancelled)
            return;
        if (error(e) === '미리보기 계산 중') {
            timer = setTimeout(() => void update(), 240);
        }
        else
            setPreviewError(error(e));
    } } timer = setTimeout(() => void update(), 220); return () => { cancelled = true; clearTimeout(timer); }; }, [p, index, time, active, selected.durationSec]);
    useEffect(() => { setTime(t => Math.max(0, Math.min(t, selected.durationSec - 1 / 24))); }, [selected.id, selected.durationSec]);
    function choose(next: MotionProject, saved = false) { if (dirty && !window.confirm('저장하지 않은 편집 내용이 있습니다. 다른 프로젝트로 이동할까요?'))
        return; setH(history(next)); setSceneId(next.scenes[0].id); setElementId(''); setBaseline(saved ? key(next) : ''); setRequestMode(saved ? 'edit' : 'create'); setRequest(null); setReview(null); setOutput(null); }
    function removeElement() { if (e)
        mutate(n => { n.scenes[index].graphics.elements = n.scenes[index].graphics.elements.filter(el => el.id !== e.id); }); }
    function pointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string, resize = false) { if (event.button !== 0)
        return; event.preventDefault(); setElementId(id); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { base: structuredClone(pRef.current), id, x: event.clientX, y: event.clientY, rect: stage.current!.getBoundingClientRect(), resize }; }
    function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) { const d = drag.current; if (!d)
        return; const n = structuredClone(d.base); const el = n.scenes[index].graphics.elements.find(e => e.id === d.id); if (!el)
        return; const dx = (event.clientX - d.x) * w / d.rect.width, dy = (event.clientY - d.y) * height / d.rect.height; if (d.resize) {
        el.width = Math.max(1, Math.min(w * 2, el.width + dx));
        el.height = Math.max(1, Math.min(height * 2, el.height + dy));
    }
    else {
        el.x = Math.max(-w, Math.min(w * 2, el.x + dx));
        el.y = Math.max(-height, Math.min(height * 2, el.y + dy));
    } setH(current => ({ ...current, present: n })); }
    function pointerUp() { const d = drag.current; if (!d)
        return; drag.current = null; setH(current => key(current.present) === key(d.base) ? current : { past: [...current.past, d.base].slice(-60), present: current.present, future: [] }); setReview(null); }
    async function add() { if (selected.graphics.elements.length >= 32)
        throw new Error('장면당 요소는 32개까지입니다.'); const el = element(addKind, selected.durationSec); el.width = Math.min(800, w - 200); el.height = Math.min(el.height, height - 450); if (addKind === 'image') {
        const image = await invoke<MotionImage | {
            cancelled: true;
        }>('motion_import_image');
        if ('cancelled' in image)
            return;
        el.assetId = image.id;
        mutate(n => { n.motionGraphics.images.push(image); n.scenes[index].graphics.elements.push(el); });
    }
    else {
        if (['bar', 'chart-line', 'donut'].includes(addKind)) {
            if (!p.motionGraphics.tables[0])
                throw new Error('먼저 표를 입력하세요.');
            el.tableId = p.motionGraphics.tables[0].id;
        }
        mutate(n => n.scenes[index].graphics.elements.push(el));
    } setElementId(el.id); }
    async function requestAI() {
        if (!instruction.trim())
            throw new Error('ChatGPT에 전달할 제작·수정 지시를 입력하세요.');
        if (scope === 'element' && !e)
            throw new Error('변경할 요소를 선택하세요.');
        if (delivery === 'codexify') {
        const connection = await invoke<{
            reachable: boolean;
            studioTools: string[];
        }>('codexify_connection_check');
        if (!connection.reachable || !['studio_motion_request_get', 'studio_motion_draft_receive'].every(name => connection.studioTools?.some(tool => tool === name || tool.endsWith(`__${name}`))))
            throw new Error('모션 MCP 도구를 연결하세요. 코딩 화면에서 연결 설정을 새로고침하세요.');
        }
        const snapshot = pRef.current;
        const r = await invoke<MotionRequest>('motion_request_create', { input: { project: snapshot, instruction, allowDataEdits, mode: requestMode, sceneIds: scope === 'all' ? [] : [selected.id], elementIds: scope === 'element' ? [e!.id] : [] } });
        setRequest(r);
        setReview(null);
        if (delivery === 'remote-desktop') {
            remoteDesktopPrompt(r);
            setNotice('요청 저장됨 · 전달문을 ChatGPT 대화에 붙여넣고 Remote Desktop Commander로 계속하세요. 초안 수신을 기다립니다.');
            return;
        }
        const profile = await getProfile();
        const sent = await sendToConnectedChat([`Toris Studio 모션 그래픽 요청 ${r.id}. 실제 연결 도구 studio_motion_request_get(requestId=${JSON.stringify(r.id)})로 요청을 읽고, studio_motion_draft_receive로 requestId, projectId, baseHash, draft.operations를 반환해줘. 도구에 접두사가 있으면 실제 등록 이름을 사용해.`, instruction, '코드·HTML·셸·필터 문자열을 반환하거나 실행하지 마. 기본적으로 원본 표 수치는 바꾸지 말고 tableId로 참조해. 요청의 allowDataEdits=true인 경우에만 지시한 수치 변경을 set-table-value {tableId,row,label,expectedValue,value} 연산으로 제안해. 전후 값이 검토되기 전에는 적용되지 않아. 이미지 자체가 필요하면 기존 파일 수신 도구를 사용해. 선택한 안정 ID와 변경되지 않은 요소를 보존해. 캔버스는 세로 1080×1920 또는 가로 1920×1080. 장면·요소 구조는 기존 데이터를 참고해. 수신은 초안이며 사용자가 적용을 승인한다.'].join('\n\n'), r.id, undefined, profile);
        setNotice(sent.waiting ? '요청을 전달했습니다. ChatGPT 변경 초안을 기다립니다.' : '요청 저장됨 · 대화 재개 필요. ChatGPT에서 대화를 직접 계속하세요.');
    }
    async function showReview(id = selected.id) { if (!request)
        return; const current = pRef.current; const k = key(current); const rid = request.id; const next = await invoke<MotionProject>('motion_draft_preview', { id: rid, project: current }); const beforeIndex = current.scenes.findIndex(s => s.id === id), afterIndex = next.scenes.findIndex(s => s.id === id); const before = beforeIndex < 0 ? null : await invoke<Frame>('motion_preview', { project: current, index: beforeIndex, time: Math.min(2, current.scenes[beforeIndex].durationSec - 1 / 24) }); const after = afterIndex < 0 ? null : await invoke<Frame>('motion_preview', { project: next, index: afterIndex, time: Math.min(2, next.scenes[afterIndex].durationSec - 1 / 24) }); if (key(pRef.current) !== k)
        throw new Error('검토 중 편집 내용이 변경됐습니다. 다시 요청하세요.'); setReview({ before, after, project: next, key: k, requestId: rid, sceneId: id }); }
    function numeric(name: keyof GraphicElement, label: string, min: number, max: number, step = 1) { return <label>{label}<input type="number" value={typeof e?.[name] === 'number' ? e[name] as number : 0} min={min} max={max} step={step} onChange={event => { const value = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(value) && value >= min && value <= max)
        updateElement({ [name]: value }); }}/></label>; }
    return <fieldset className="motion-studio" aria-label="모션 그래픽 제작" disabled={busy === '초안 적용' || busy === '요소 추가'}>
  <header className="motion-heading"><div><span>VIDEO STUDIO / MOTION</span><h2>자료를 움직이는 이야기로</h2><p>자료 입력 → ChatGPT 변경 초안 → 검토·적용 → 직접 편집 → MP4</p></div><div className="motion-actions"><button onClick={() => setH(undoHistory)} disabled={!h.past.length || !!busy}><Undo2 size={16}/>실행 취소</button><button onClick={() => setH(redoHistory)} disabled={!h.future.length || !!busy}><Redo2 size={16}/>다시 실행</button><button className="primary" disabled={!!busy} onClick={() => void run('저장', async () => { const saved = await invoke<MotionProject>('video_save_project', { input: p }); if (key(pRef.current) === key(p)) {
        setH(current => ({ ...current, present: saved }));
        setBaseline(key(saved));
    } await load(); setNotice('프로젝트를 저장했습니다.'); })}><Save size={16}/>프로젝트 저장{dirty ? ' *' : ''}</button></div></header>
  {notice && <p className="motion-notice" role="status">{notice}</p>}
  <div className="motion-project-bar"><label>저장한 모션<select aria-label="저장한 모션" value={projects.some(v => v.id === p.id) ? p.id : ''} onChange={ev => { const next = projects.find(v => v.id === ev.target.value); if (next)
        choose(next, true); }}><option value="">현재 편집 중</option>{projects.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label><label>시작 구성<select aria-label="시작 구성" value={template} onChange={ev => setTemplate(ev.target.value as TemplateKind)}>{templateKinds.map(k => <option key={k} value={k}>{templateLabels[k]}</option>)}</select></label><button onClick={() => choose(newMotionProject(template))} disabled={!!busy}><Plus size={16}/>새 모션 프로젝트</button><label>제목<input value={p.title} maxLength={300} onChange={ev => mutate(n => { n.title = ev.target.value; })}/></label><label>화면 비율<select aria-label="화면 비율" value={p.format} onChange={ev => commit(changeFormat(p, ev.target.value as MotionProject['format']))}><option value="shorts">세로 9:16</option><option value="youtube-landscape">가로 16:9</option></select></label></div>
  <details className="motion-sources"><summary>자료 입력 · 설명문, 표/CSV, 이미지</summary><div className="motion-source-grid"><label>설명문·참고자료<textarea maxLength={12000} value={p.motionGraphics.description} onChange={ev => mutate(n => { n.motionGraphics.description = ev.target.value; })} placeholder="원본 자료와 전달할 내용을 붙여넣으세요."/></label><div><label>표 붙여넣기 · 항목, 숫자<textarea aria-label="표 붙여넣기 · 항목, 숫자" value={csv} onChange={ev => setCsv(ev.target.value)}/></label><div className="motion-actions"><label className="motion-file">CSV 가져오기<input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" onChange={ev => { const file = ev.target.files?.[0]; if (file)
        void run('CSV 읽기', async () => { if (file.size > 32000)
            throw new Error('CSV는 32KB 이하입니다.'); setCsv(await file.text()); }); ev.target.value = ''; }}/></label><button onClick={() => void run('표 확인', async () => { const rows = parseTable(csv); mutate(n => { if (n.motionGraphics.tables[0])
        n.motionGraphics.tables[0].rows = rows;
    else
        n.motionGraphics.tables.push({ id: 'data', name: '입력한 원본 표', rows }); }); })}>원본 표에 반영</button></div></div></div>
   {p.motionGraphics.tables.map((table, ti) => <div key={table.id} className="motion-table"><label>표 이름<input value={table.name} maxLength={120} onChange={ev => mutate(n => { n.motionGraphics.tables[ti].name = ev.target.value; })}/></label><p>직접 확인한 원본 수치입니다. 수치 변경은 별도 허용한 초안의 전후 값을 검토한 뒤 적용합니다.</p><table><thead><tr><th>항목</th><th>수치</th></tr></thead><tbody>{table.rows.map((r, ri) => <tr key={ri}><td><input aria-label={`표 ${ti + 1} ${ri + 1}행 항목`} value={r.label} maxLength={80} onChange={ev => mutate(n => { n.motionGraphics.tables[ti].rows[ri].label = ev.target.value; })}/></td><td><input aria-label={`표 ${ti + 1} ${ri + 1}행 수치`} type="number" min={0} max={1e12} value={r.value} onChange={ev => { const v = Number(ev.target.value); if (ev.target.value && Number.isFinite(v) && v >= 0 && v <= 1e12)
        mutate(n => { n.motionGraphics.tables[ti].rows[ri].value = v; }); }}/></td></tr>)}</tbody></table></div>)}
   {p.motionGraphics.images.map((image, i) => <label key={image.id}>이미지 {i + 1} · {image.width}×{image.height}<input aria-label={`이미지 ${i + 1} 설명`} value={image.description} maxLength={1000} onChange={ev => mutate(n => { n.motionGraphics.images[i].description = ev.target.value; })}/><small>원본은 로컬에 보관하며 AI에는 ID·크기·설명만 전달합니다.</small></label>)}
  </details>
  <div className="motion-workspace"><aside className="motion-scenes" aria-label="장면 목록"><div className="motion-section-heading"><strong>장면 {p.scenes.length}/12</strong><span>{total.toFixed(1)}초 / 180</span></div>{p.scenes.map((s, i) => <div key={s.id} className={s.id === selected.id ? 'motion-scene selected' : 'motion-scene'}><button className="motion-scene-select" aria-pressed={s.id === selected.id} onClick={() => { setSceneId(s.id); setElementId(''); }}><span>{String(i + 1).padStart(2, '0')}</span><span>{s.headline || `장면 ${i + 1}`}<small>{s.durationSec}초 · {s.graphics.elements.length}요소</small></span></button><div className="motion-actions"><button aria-label={`${i + 1}번 장면 위로`} disabled={i === 0} onClick={() => mutate(n => { const [s] = n.scenes.splice(i, 1); n.scenes.splice(i - 1, 0, s); })}>↑</button><button aria-label={`${i + 1}번 장면 아래로`} disabled={i === p.scenes.length - 1} onClick={() => mutate(n => { const [s] = n.scenes.splice(i, 1); n.scenes.splice(i + 1, 0, s); })}>↓</button><button aria-label={`${i + 1}번 장면 복제`} disabled={p.scenes.length >= 12 || total + s.durationSec > 180} onClick={() => mutate(n => { const copy = structuredClone(s); copy.id = `scene-${crypto.randomUUID()}`; copy.graphics.elements = copy.graphics.elements.map(e => ({ ...e, id: `el-${crypto.randomUUID()}` })); n.scenes.splice(i + 1, 0, copy); })}><Copy size={13}/></button><button aria-label={`${i + 1}번 장면 삭제`} disabled={p.scenes.length <= 1} onClick={() => mutate(n => { n.scenes.splice(i, 1); })}><Trash2 size={13}/></button></div></div>)}<button disabled={p.scenes.length >= 12 || total + 9 > 180} onClick={() => { const s = newMotionScene(template, p.motionGraphics.tables[0]?.id); if (p.format === 'youtube-landscape') {
        const temp = newMotionProject();
        temp.scenes = [s];
        const scaled = changeFormat(temp, p.format);
        mutate(n => n.scenes.push(scaled.scenes[0]));
    }
    else
        mutate(n => n.scenes.push(s)); setSceneId(s.id); }}><Plus size={15}/>장면 추가</button></aside>
   <main className="motion-center"><div className="motion-canvas-toolbar"><span>장면 {index + 1} · {w}×{height}</span><button disabled={!!busy} onClick={() => void run('재생 미리보기', async () => { const k = key(p); const result = await invoke<Output>('motion_preview_video', { project: p, index }); if (key(pRef.current) !== k)
        throw new Error('편집 후 도착한 이전 미리보기를 폐기했습니다.'); await openRenderPreview(result.path); })}><Play size={15}/>이 장면 재생</button></div><div className="motion-stage-wrap"><div ref={stage} className={`motion-stage ${p.format === 'youtube-landscape' ? 'landscape' : ''}`} style={{ aspectRatio: `${w}/${height}` }} aria-label="편집 캔버스">
    {frame ? <img src={frame.dataUrl} alt={`${index + 1}번 장면 ${time.toFixed(2)}초 Rust 미리보기`} draggable={false}/> : <div className="motion-canvas-status" role="status">{previewError || '미리보기를 계산하고 있습니다.'}</div>}
    {selected.graphics.elements.map(el => <button key={el.id} className={`motion-element ${e?.id === el.id ? 'selected' : ''}`} style={{ left: `${el.x / w * 100}%`, top: `${el.y / height * 100}%`, width: `${el.width / w * 100}%`, height: `${el.height / height * 100}%`, zIndex: el.z + 1001 }} aria-label={`${labels[el.kind]}: ${el.text || el.id}`} aria-pressed={e?.id === el.id} onPointerDown={ev => pointerDown(ev, el.id)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { const d = drag.current; drag.current = null; if (d)
        setH(current => ({ ...current, present: d.base })); }} onFocus={() => setElementId(el.id)} onKeyDown={ev => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
        ev.preventDefault();
        const step = ev.shiftKey ? 10 : 1;
        updateElement({ x: Math.max(-w, Math.min(w * 2, el.x + (ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0))), y: Math.max(-height, Math.min(height * 2, el.y + (ev.key === 'ArrowDown' ? step : ev.key === 'ArrowUp' ? -step : 0))) });
    } if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        removeElement();
    } if ((ev.metaKey || ev.ctrlKey) && ev.key === 'd') {
        ev.preventDefault();
        commit(duplicateElement(p, selected.id, el.id));
    } }}>{e?.id === el.id && <span className="motion-selection-label">{labels[el.kind]}</span>}</button>)}
    {e && <button className="motion-resize" aria-label="선택 요소 크기 조절" style={{ left: `${(e.x + e.width) / w * 100}%`, top: `${(e.y + e.height) / height * 100}%` }} onPointerDown={ev => pointerDown(ev, e.id, true)} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={ev => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
        ev.preventDefault();
        updateElement({ width: Math.max(1, Math.min(w * 2, e.width + (ev.key === 'ArrowRight' ? 10 : ev.key === 'ArrowLeft' ? -10 : 0))), height: Math.max(1, Math.min(height * 2, e.height + (ev.key === 'ArrowDown' ? 10 : ev.key === 'ArrowUp' ? -10 : 0))) });
    } }}>↘</button>}
   </div></div><div className="motion-timeline"><label>재생 위치 {time.toFixed(2)}초<input aria-label="재생 위치" type="range" min={0} max={Math.max(0, selected.durationSec - 1 / 24)} step={1 / 24} value={time} onChange={ev => setTime(Number(ev.target.value))}/></label><input aria-label="재생 위치 초" type="number" step={1 / 24} min={0} max={selected.durationSec - 1 / 24} value={Number(time.toFixed(3))} onChange={ev => { const t = Number(ev.target.value); if (Number.isFinite(t) && t >= 0 && t < selected.durationSec)
        setTime(t); }}/></div><p className="motion-help">요소를 드래그하거나 방향키로 이동 · Shift로 10px · 모서리로 크기 조절 · 속성에서 정확한 값 입력</p></main>
   <aside className="motion-inspector" aria-label="요소 속성"><h3>장면 속성</h3><label>장면 이름<input value={selected.headline} maxLength={300} onChange={ev => mutate(n => { n.scenes[index].headline = ev.target.value; })}/></label><label>장면 길이 (초)<input type="number" min={0.1} max={180} step={0.1} value={selected.durationSec} onChange={ev => { const v = Number(ev.target.value); if (v >= 1 / 24 && v <= 180 && total - selected.durationSec + v <= 180)
        mutate(n => { n.scenes[index].durationSec = v; }); }}/></label><label>배경색<input type="color" value={selected.graphics.background} onChange={ev => mutate(n => { n.scenes[index].graphics.background = ev.target.value; })}/></label><hr /><label>요소 선택<select aria-label="요소 선택" value={e?.id ?? ''} onChange={ev => setElementId(ev.target.value)}><option value="">요소를 선택하세요</option>{selected.graphics.elements.map(el => <option key={el.id} value={el.id}>{labels[el.kind]} · {el.text?.slice(0, 20) || el.id.slice(-8)}</option>)}</select></label><div className="motion-actions"><select aria-label="추가할 요소 종류" value={addKind} onChange={ev => setAddKind(ev.target.value as ElementKind)}>{kinds.map(k => <option key={k} value={k}>{labels[k]}</option>)}</select><button aria-label="요소 추가" disabled={!!busy || selected.graphics.elements.length >= 32} onClick={() => void run('요소 추가', add)}><Plus size={16}/></button></div>
    {e && <><div className="motion-section-heading"><h3>{labels[e.kind]}</h3><div className="motion-actions"><button aria-label="선택 요소 복제" disabled={selected.graphics.elements.length >= 32} onClick={() => { try {
        commit(duplicateElement(p, selected.id, e.id));
    }
    catch (err) {
        setNotice(error(err));
    } }}><Copy size={15}/></button><button aria-label="선택 요소 삭제" onClick={removeElement}><Trash2 size={15}/></button></div></div>{e.kind === 'text' && <><label>텍스트<textarea value={e.text} maxLength={2000} onChange={ev => updateElement({ text: ev.target.value })}/></label>{numeric('fontSize', '글자 크기', 8, 300)}</>}<div className="motion-fields">{numeric('x', 'X', -w, w * 2)}{numeric('y', 'Y', -height, height * 2)}{numeric('width', '너비', 1, w * 2)}{numeric('height', '높이', 1, height * 2)}{numeric('z', '겹침 순서', -1000, 1000)}{numeric('start', '등장 시각', 0, selected.durationSec, 0.1)}{numeric('duration', '표시 길이', 1 / 24, 180, 0.1)}</div><label>색상<input type="color" value={e.color} onChange={ev => updateElement({ color: ev.target.value })}/></label><label>애니메이션<select aria-label="애니메이션" value={e.animation} onChange={ev => updateElement({ animation: ev.target.value as GraphicElement['animation'] })}>{Object.entries({ none: '정지', fade: '등장 · 불투명도', rise: '아래에서 이동', slide: '옆에서 이동', zoom: '확대', draw: '차트 그리기', 'fade-out': '퇴장' }).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>{e.tableId && <label>원본 표<select aria-label="원본 표" value={e.tableId} onChange={ev => updateElement({ tableId: ev.target.value })}>{p.motionGraphics.tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}<small className="motion-id">ID: {e.id}</small></>}
   </aside></div>
  <section className="motion-ai" aria-label="ChatGPT 모션 요청"><div><h3><Sparkles size={18}/>ChatGPT와 함께 편집</h3><p>기존 연결을 사용합니다. 초안 수신 뒤 검토·적용하며, 새 음성은 생성하지 않습니다.</p><textarea aria-label="모션 제작·수정 지시" value={instruction} maxLength={6000} onChange={ev => setInstruction(ev.target.value)} placeholder="예: 원본 표로 5장면 설명 영상을 만들어줘 / 두 번째 장면을 12초로 늘려줘"/><div className="motion-actions"><label>전달 연결<select aria-label="전달 연결" value={delivery} onChange={ev => setDelivery(ev.target.value as typeof delivery)}><option value="remote-desktop">Remote Desktop Commander</option><option value="codexify">Codexify</option></select></label><label>요청 방식<select aria-label="요청 방식" value={requestMode} onChange={ev => setRequestMode(ev.target.value as typeof requestMode)}><option value="create">새 구성 제작</option><option value="edit">기존 내용 수정</option></select></label><label>변경 범위<select aria-label="변경 범위" value={scope} onChange={ev => setScope(ev.target.value as typeof scope)}><option value="all">전체 프로젝트</option><option value="scene">선택 장면 수정</option><option value="element">선택 요소만 수정</option></select></label><label className="motion-check"><input type="checkbox" checked={allowDataEdits} disabled={scope !== 'all'} onChange={ev => setAllowDataEdits(ev.target.checked)}/>원본 수치 변경 초안 허용 · 전후 값 검토</label><button disabled={!!busy || !instruction.trim()} onClick={() => void run('ChatGPT 요청', requestAI)}><Sparkles size={16}/>ChatGPT에 요청</button>{delivery === 'codexify' && <button onClick={() => void run('대화 열기', async () => { await openConnectedChat(); })}>ChatGPT 대화 열기</button>}</div></div>
   {handoff && <div className="motion-handoff"><label>ChatGPT 전달문<textarea aria-label="ChatGPT 전달문" readOnly value={handoff} rows={8}/></label><button disabled={!!busy} onClick={() => void run('전달문 복사', async () => { await navigator.clipboard.writeText(handoff); setNotice('전달문을 복사했습니다. ChatGPT에서 Remote Desktop Commander로 계속하세요.'); })}><Copy size={16}/>전달문 복사</button><p>현재 앱의 표준입출력 연결로 요청을 읽고 초안만 반환합니다. ChatGPT에서 대화를 계속해야 하며, 수신 후 여기에서 검토·적용하세요.</p></div>}
   {request && <article className="motion-request"><strong>{request.status === 'received' ? '변경 초안 수신 · 검토 필요' : '요청 저장됨 · ChatGPT 응답 대기'}</strong><p>{request.instruction}</p>{conflicted && <p role="alert">요청 이후 수동 편집 충돌이 있습니다. 현재 편집 내용으로 다시 요청하세요.</p>}<small>{request.id}</small><div className="motion-actions"><button disabled={!!busy || request.status !== 'received' || conflicted} onClick={() => void run('변경 검토', showReview)}>변경 검토</button><button disabled={!!busy} onClick={() => void run('요청 거절', async () => { await invoke('motion_request_cancel', { id: request.id }); setRequest(null); setReview(null); setNotice('요청을 거절했습니다. 기존 편집은 유지합니다.'); })}>거절·취소</button><button aria-label="초안 상태 새로고침" disabled={!!busy} onClick={() => void run('상태 조회', async () => { const all = await invoke<MotionRequest[]>('motion_request_list'); setRequest(all.find(r => r.id === request.id) ?? null); })}><RefreshCw size={15}/></button></div></article>}
  </section>
  {review && request && review.requestId === request.id && <section className="motion-review" aria-label="변경 전후 검토"><h3>변경 초안 · {request.draft?.operations.length}개 변경</h3><ol>{request.draft?.operations.map((op, i) => <li key={i}>{String(op.op)} · {String(op.sceneId ?? (op.scene as MotionScene)?.id ?? '새 장면')}{op.elementId ? ` · ${String(op.elementId)}` : ''}{op.durationSec ? ` · ${String(op.durationSec)}초` : ''}{op.op === 'set-table-value' ? ` · ${String(op.tableId)} / ${String(op.label)}: ${String(op.expectedValue)} → ${String(op.value)}` : ''}</li>)}</ol><label>검토 장면<select aria-label="검토 장면" value={review.sceneId} disabled={!!busy} onChange={ev => void run('변경 검토', () => showReview(ev.target.value))}>{Array.from(new Map([...p.scenes, ...review.project.scenes].map(s => [s.id, s])).values()).map(s => <option key={s.id} value={s.id}>{s.headline || s.id}</option>)}</select></label><div className="motion-review-images"><figure><figcaption>현재 장면</figcaption>{review.before ? <img src={review.before.dataUrl} alt="변경 전 장면"/> : <p>새로 추가한 장면</p>}</figure><figure><figcaption>변경 후 장면</figcaption>{review.after ? <img src={review.after.dataUrl} alt="변경 후 장면"/> : <p>삭제할 장면</p>}</figure></div><details><summary>모든 변경 데이터 확인</summary><pre>{JSON.stringify(request.draft, null, 2)}</pre></details><div className="motion-actions"><button className="primary" disabled={!!busy || conflicted} onClick={() => void run('초안 적용', async () => { if (!canApplyReview(review, request.id, pRef.current))
        throw new Error('편집 충돌이 있습니다. 다시 요청하세요.'); const next = await invoke<MotionProject>('motion_draft_apply', { id: request.id, project: pRef.current }); if (!canApplyReview(review, request.id, pRef.current))
        throw new Error('적용 대기 중 편집 충돌이 있습니다. 현재 편집을 유지합니다. 다시 요청하세요.'); commit(next); setRequest(null); setNotice('변경 초안을 적용했습니다. 실행 취소 한 번으로 복원할 수 있습니다. 프로젝트 저장을 실행하세요.'); })}>검토한 변경 적용</button><button onClick={() => setReview(null)}>검토 닫기</button></div></section>}
  <footer className="motion-export"><div><strong>MP4 · 1080p / 24fps</strong><p>H.264 / AAC · 한국어 · {total.toFixed(1)}초 · 기존 음성 연결 유지</p></div><button className="primary" disabled={!!busy || total > 180} onClick={() => void run('MP4 출력', async () => { const snapshot = pRef.current, k = key(snapshot); const channel = new Channel<VideoRenderProgressMessage>(); channel.onmessage = progress => setNotice(`MP4 출력 · ${progress.completedScenes}/${progress.totalScenes}장면`); const result = await invoke<Output>('video_render_project', { project: snapshot, onProgress: channel }); setOutput(result); setOutputKey(k); setNotice(key(pRef.current) === k ? 'MP4 출력 완료. 저장 위치를 선택하세요.' : '출력 중 편집이 변경됐습니다. 최신 내용으로 다시 출력하세요.'); })}><Download size={16}/>{busy === 'MP4 출력' ? 'MP4 출력 중…' : 'MP4 출력'}</button>{output && <><button disabled={!!busy || !rendered} onClick={() => void run('MP4 저장', async () => { const r = await invoke<{
        path?: string;
        cancelled?: boolean;
    }>('motion_save_video', { path: output.path }); if (r.path)
        setNotice(`MP4 저장 완료 · ${r.path}`); })}>MP4 저장</button><button disabled={!!busy || !rendered} onClick={() => void run('출력 확인', async () => { await openRenderPreview(output.path); })}><Play size={16}/>완성 영상 확인</button></>}{busy && <span role="status">{busy}…</span>}</footer>
 </fieldset>;
}
