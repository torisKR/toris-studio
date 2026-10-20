import type { VideoProject, VideoScene } from '../../../lib/video/types';
export const templateKinds = ['title', 'metric', 'chart', 'comparison', 'steps'] as const;
export type TemplateKind = typeof templateKinds[number];
export const templateLabels: Record<TemplateKind, string> = { title: '타이틀', metric: '수치 강조', chart: '차트', comparison: '비교', steps: '단계 설명' };
import type { ElementKind, Animation, GraphicElement, Graphics, TableRow, MotionTable, MotionImage, MotionScene, MotionProject } from "../../../lib/video/graphics";
export type { ElementKind, Animation, GraphicElement, Graphics, TableRow, MotionTable, MotionImage, MotionScene, MotionProject } from "../../../lib/video/graphics";
export type MotionRequest = {
    id: string;
    projectId: string;
    baseHash: string;
    mode: 'create' | 'edit';
    instruction: string;
    allowDataEdits?: boolean;
    sceneIds: string[];
    elementIds: string[];
    project: MotionProject;
    status: 'waiting' | 'received' | 'cancelled' | 'applied';
    draft?: {
        operations: Array<Record<string, unknown>>;
    };
    createdAt: string;
};
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function element(kind: ElementKind, duration = 9): GraphicElement {
    return { id: uid('el'), kind, x: 100, y: 450, width: 800, height: kind === 'text' ? 200 : 600, z: 1, color: '#8ae3bb', start: 0, duration, animation: kind === 'text' ? 'rise' : 'draw', ...(kind === 'text' ? { text: '새 텍스트', fontSize: 72 } : {}) };
}
export function newMotionScene(kind: TemplateKind = 'title', tableId = 'example'): MotionScene {
    const title = { ...element('text'), y: 170, text: templateLabels[kind], fontSize: 88 };
    const content: GraphicElement[] = [];
    if (kind === 'title')
        content.push({ ...element('text'), y: 650, height: 450, text: '전하고 싶은 메시지를\n직접 편집하세요.', fontSize: 80 });
    if (kind === 'metric')
        content.push({ ...element('text'), y: 680, height: 350, text: '18%', fontSize: 240, color: '#ffffff' }, { ...element('text'), y: 1100, text: '수치는 예시입니다. 자료를 확인하세요.', fontSize: 42 });
    if (kind === 'chart')
        content.push({ ...element('bar'), tableId, y: 550, height: 900 });
    if (kind === 'comparison')
        content.push({ ...element('rectangle'), x: 80, y: 620, width: 440, height: 600, color: '#223b48', animation: 'fade' }, { ...element('rectangle'), x: 560, y: 620, width: 440, height: 600, color: '#315446', animation: 'fade' }, { ...element('text'), x: 120, y: 700, width: 340, height: 420, text: '이전\n12', fontSize: 100 }, { ...element('text'), x: 600, y: 700, width: 340, height: 420, text: '이후\n18', fontSize: 100 });
    if (kind === 'steps')
        for (let i = 0; i < 3; i++)
            content.push({ ...element('text'), y: 550 + i * 300, start: i * 0.3, text: `0${i + 1}  ${['자료 확인', '핵심 정리', '결과 공유'][i]}`, fontSize: 64 });
    return { id: uid('scene'), headline: templateLabels[kind], body: '', narration: '', durationSec: 9, mediaType: 'none', graphics: { version: 1, background: '#101820', elements: [title, ...content] } };
}
export function newMotionProject(kind: TemplateKind = 'title'): MotionProject {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), title: `새 모션 · ${templateLabels[kind]}`, format: 'shorts', template: 'reference-briefing', language: 'ko', createdAt: now, updatedAt: now, motionGraphics: { version: 1, description: '', tables: [{ id: 'example', name: '예시 데이터 · 원본으로 교체하세요', rows: [{ label: 'Q1', value: 12 }, { label: 'Q2', value: 15 }, { label: 'Q3', value: 18 }, { label: 'Q4', value: 24 }] }], images: [] }, scenes: [kind, ...templateKinds.filter(k => k !== kind)].map(k => newMotionScene(k)) };
}
export function parseTable(raw: string): TableRow[] {
    if (raw.length > 32000)
        throw new Error('표는 32000자 이내입니다.');
    const source = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const delim = source.includes('\t') ? '\t' : ',';
    const rows: string[][] = [];
    let row: string[] = [], field = '', quoted = false, closed = false;
    for (let i = 0; i <= source.length; i++) {
        const c = source[i] ?? '\n';
        if (quoted) {
            if (c === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    quoted = false;
                    closed = true;
                }
            }
            else if (i === source.length)
                throw new Error('CSV 따옴표를 닫으세요.');
            else
                field += c;
            continue;
        }
        if (c === '"' && !field && !closed) {
            quoted = true;
            continue;
        }
        if (c === delim || c === '\n') {
            row.push(field.trim());
            field = '';
            closed = false;
            if (c === '\n') {
                if (row.some(Boolean))
                    rows.push(row);
                row = [];
            }
            continue;
        }
        if (closed && c.trim())
            throw new Error('CSV 따옴표 뒤 구분자를 확인하세요.');
        field += c;
    }
    if (rows[0]?.length === 2 && /^(label|name|분기|항목)$/i.test(rows[0][0]) && /^(value|수치|값)$/i.test(rows[0][1]))
        rows.shift();
    if (!rows.length || rows.length > 24)
        throw new Error('표는 1~24행입니다.');
    return rows.map(r => { if (r.length !== 2 || !r[0] || r[0].length > 80 || !/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(r[1]) || !Number.isFinite(Number(r[1])) || Number(r[1]) > 1e12)
        throw new Error('각 행에 항목과 0 이상 숫자 두 열을 입력하세요.'); return { label: r[0], value: Number(r[1]) }; });
}
export type History = {
    past: MotionProject[];
    present: MotionProject;
    future: MotionProject[];
};
export function history(p: MotionProject): History { return { past: [], present: p, future: [] }; }
export function pushHistory(h: History, p: MotionProject): History { return JSON.stringify(h.present) === JSON.stringify(p) ? h : { past: [...h.past, h.present].slice(-60), present: p, future: [] }; }
export function undoHistory(h: History): History { return h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h; }
export function redoHistory(h: History): History { return h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h; }
export function duplicateElement(p: MotionProject, sceneId: string, elementId: string): MotionProject {
    const next = structuredClone(p), s = next.scenes.find(s => s.id === sceneId), e = s?.graphics.elements.find(e => e.id === elementId);
    if (!s || !e || s.graphics.elements.length >= 32)
        throw new Error('요소는 장면당 32개까지입니다.');
    s.graphics.elements.push({ ...e, id: uid('el'), x: e.x + 24, y: e.y + 24, z: Math.min(1000, e.z + 1) });
    return next;
}
export function dimensions(p: MotionProject): [
    number,
    number
] { return p.format === 'youtube-landscape' ? [1920, 1080] : [1080, 1920]; }
export function changeFormat(p: MotionProject, format: MotionProject['format']): MotionProject { const n = structuredClone(p), [ow, oh] = dimensions(p); n.format = format; const [w, h] = dimensions(n); for (const s of n.scenes)
    for (const e of s.graphics.elements) {
        e.x *= w / ow;
        e.y *= h / oh;
        e.width *= w / ow;
        e.height *= h / oh;
        if (e.fontSize)
            e.fontSize = Math.max(8, Math.min(300, e.fontSize * Math.min(w / ow, h / oh)));
    } return n; }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value; }
export function editingKey(p: MotionProject): string { return JSON.stringify(canonical({ ...p, createdAt: undefined, updatedAt: undefined })); }
export function canApplyReview(review: {
    requestId: string;
    key: string;
}, requestId: string, p: MotionProject): boolean { return review.requestId === requestId && review.key === editingKey(p); }
