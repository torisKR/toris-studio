import test from 'node:test';
import assert from 'node:assert/strict';
import * as motion from '../desktop/src/motion/model';
test('five Korean 45-second templates use stable IDs and valid references', () => {
    for (const kind of motion.templateKinds) {
        const p = motion.newMotionProject(kind);
        assert.equal(p.scenes.length, 5);
        assert.equal(p.language, 'ko');
        assert.equal(p.format, 'shorts');
        assert.equal(p.scenes.reduce((n, s) => n + s.durationSec, 0), 45);
        assert.equal(new Set(p.scenes.map(s => s.id)).size, 5);
        assert.ok(p.scenes.every(s => s.graphics.elements.length <= 32));
    }
});
test('CSV supports Korean, quoted commas, TSV and strict numeric validation', () => {
    assert.deepEqual(motion.parseTable('label,value\n"매출, 국내",18\n해외,24'), [{ label: '매출, 국내', value: 18 }, { label: '해외', value: 24 }]);
    assert.deepEqual(motion.parseTable('분기\t수치\nQ3\t18'), [{ label: 'Q3', value: 18 }]);
    for (const csv of ['Q3,18%', 'Q3,', 'Q3,Infinity', 'Q3,-1', '"미완성,18', Array.from({ length: 25 }, (_, i) => `Q${i},${i}`).join('\n')])
        assert.throws(() => motion.parseTable(csv));
});
test('history applies AI draft as one undo and duplicate preserves unrelated elements', () => {
    const p = motion.newMotionProject('title');
    const h = motion.history(p);
    const changed = structuredClone(p);
    changed.scenes[0].durationSec = 12;
    const applied = motion.pushHistory(h, changed);
    assert.deepEqual(motion.undoHistory(applied).present, p);
    assert.deepEqual(motion.redoHistory(motion.undoHistory(applied)).present, changed);
    const e = p.scenes[0].graphics.elements[0];
    const next = motion.duplicateElement(p, p.scenes[0].id, e.id);
    assert.deepEqual(next.scenes[0].graphics.elements.slice(0, -1), p.scenes[0].graphics.elements);
    assert.notEqual(next.scenes[0].graphics.elements.at(-1)?.id, e.id);
});
test('review authorization binds request and snapshot, including changes during IPC', () => {
    const p = motion.newMotionProject(), review = { requestId: 'A', key: motion.editingKey(p) };
    assert.equal(motion.canApplyReview(review, 'A', p), true);
    assert.equal(motion.canApplyReview(review, 'B', p), false);
    const edited = structuredClone(p);
    edited.title = '수동 편집';
    assert.equal(motion.canApplyReview(review, 'A', edited), false);
});
test('editing identity is canonical across native JSON field reordering', () => {
    const p = motion.newMotionProject();
    const reordered = JSON.parse(JSON.stringify(p, Object.keys(p).sort()));
    function sort(v: unknown): unknown { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : v; }
    assert.equal(motion.editingKey(p), motion.editingKey(sort(p) as typeof p));
});
test('Remote Desktop Commander handoff identifies the current native bridge without embedding project data', () => {
    const prompt = motion.remoteDesktopPrompt({ id: 'request-123', mcpExecutable: '/Applications/Toris Studio.app/Contents/MacOS/toris-studio-desktop' });
    assert.match(prompt, /Remote Desktop Commander/);
    assert.match(prompt, /--studio-mcp/);
    assert.match(prompt, /studio_motion_request_get/);
    assert.match(prompt, /studio_motion_draft_receive/);
    assert.match(prompt, /request-123/);
    assert.match(prompt, /검토/);
    assert.throws(() => motion.remoteDesktopPrompt({ id: 'request-123' }), /실행 파일/);
});
