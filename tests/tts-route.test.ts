import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST } from "../app/api/tts/route";
import { pcm16ToWav } from "../lib/tts/wav";

function request(body: unknown) {
  return new Request("http://studio.invalid/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function wav(sample: number) {
  const pcm = new Uint8Array(4800);
  new DataView(pcm.buffer).setInt16(0, sample, true);
  return pcm16ToWav(pcm, 24000);
}

async function isolatedCwd(callback: (directory: string) => Promise<void>) {
  const originalCwd = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "toris-tts-route-test-"));
  try {
    process.chdir(directory);
    await callback(directory);
  } finally {
    process.chdir(originalCwd);
    await rm(directory, { recursive: true, force: true });
  }
}

test("regenerating a scene creates two UUID URLs and preserves both earlier audio files", async (t) => {
  const audios = [wav(1000), wav(2000)];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(audios[calls++], {
    headers: { "content-type": "audio/wav", "x-duration-seconds": "999" }
  }));
  await isolatedCwd(async (directory) => {
    const generated = path.join(directory, "public/generated/project");
    await mkdir(generated, { recursive: true });
    const legacy = new Uint8Array([1, 2, 3]);
    await writeFile(path.join(generated, "scene.wav"), legacy);
    const first = await POST(request({ projectId: "project", sceneId: "scene", text: "처음" }));
    const second = await POST(request({ projectId: "project", sceneId: "scene", text: "다시" }));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assert.match(a.audioPath, /^\/generated\/project\/scene-[0-9a-f-]{36}\.wav$/);
    assert.match(b.audioPath, /^\/generated\/project\/scene-[0-9a-f-]{36}\.wav$/);
    assert.notEqual(a.audioPath, b.audioPath);
    assert.equal(a.durationSec, 0.1);
    assert.equal(a.sampleRate, 24000);
    assert.deepEqual(new Uint8Array(await readFile(path.join(directory, "public", a.audioPath))), audios[0]);
    assert.deepEqual(new Uint8Array(await readFile(path.join(directory, "public", b.audioPath))), audios[1]);
    assert.deepEqual(new Uint8Array(await readFile(path.join(generated, "scene.wav"))), legacy);
    assert.equal((await readdir(generated)).length, 3);
  });
  assert.equal(calls, 2);
});

test("all four supported languages and trimmed text reach the synthesis request", async (t) => {
  const forwarded: Array<{ text: string; language: string }> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    forwarded.push(JSON.parse(String(init?.body)));
    return new Response(wav(1000), { headers: { "content-type": "audio/wav" } });
  });
  await isolatedCwd(async () => {
    for (const language of ["Korean", "English", "Japanese", "Chinese"]) {
      const response = await POST(request({ projectId: "p", sceneId: "s", text: "  테스트  ", language }));
      assert.equal(response.status, 200);
    }
  });
  assert.deepEqual(forwarded.map(({ text, language }) => ({ text, language })),
    ["Korean", "English", "Japanese", "Chinese"].map((language) => ({ text: "테스트", language })));
});

test("invalid input returns 400 before synthesis or filesystem writes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("Invalid input must not reach synthesis");
  });
  await isolatedCwd(async (directory) => {
    for (const invalid of [
      { text: "" }, { text: " \n\t " }, { text: "가".repeat(4001) },
      { text: "안녕", language: "French" }, { text: 123 },
    ]) {
      const response = await POST(request({ projectId: "p", sceneId: "s", ...invalid }));
      assert.equal(response.status, 400);
    }
    const malformed = new Request("http://studio.invalid/api/tts", { method: "POST", body: "{" });
    assert.equal((await POST(malformed)).status, 400);
    assert.deepEqual(await readdir(directory), []);
  });
  assert.equal(calls, 0);
});

test("4000-character boundary is accepted and rejected audio never creates an asset", async (t) => {
  let malformed = false;
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => malformed
    ? new Response("not audio", { headers: { "content-type": "audio/wav" } })
    : new Response(wav(1000), { headers: { "content-type": "audio/wav" } }));
  await isolatedCwd(async (directory) => {
    const valid = await POST(request({ projectId: "p", sceneId: "s", text: "가".repeat(4000) }));
    assert.equal(valid.status, 200);
    const assetPath = (await valid.json()).audioPath;
    const before = await readFile(path.join(directory, "public", assetPath));
    malformed = true;
    const rejected = await POST(request({ projectId: "p", sceneId: "s", text: "잘못된 응답" }));
    assert.equal(rejected.status, 500);
    assert.equal((await readdir(path.join(directory, "public/generated/p"))).length, 1);
    assert.deepEqual(await readFile(path.join(directory, "public", assetPath)), before);
  });
});
