import { test } from "node:test";
import assert from "node:assert/strict";
import { getQwen3TtsConfiguration, synthesizeWithQwen3Tts } from "../lib/tts/qwen3-local";
import { pcm16ToWav, readPcm16Wav } from "../lib/tts/wav";

function spokenWav(sampleRate = 24000, channels = 1) {
  const pcm = new Uint8Array(sampleRate * channels * 2 / 4);
  new DataView(pcm.buffer).setInt16(0, 1200, true);
  return pcm16ToWav(pcm, sampleRate, channels);
}

function wavResponse(wav = spokenWav(), extraHeaders: Record<string, string> = {}) {
  return new Response(wav, {
    headers: { "content-type": "audio/wav", ...extraHeaders }
  });
}

test("MLX health fallback and synthesis options remain compatible; synthesis timeout is 300 seconds", async (t) => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  const wav = spokenWav();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/health")) return Response.json({ ok: true, speaker: "Sohee" });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text, "테스트");
    assert.equal(body.speaker, "Sohee");
    assert.equal(body.language, "Japanese");
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.top_p, 0.95);
    assert.equal(body.top_k, 50);
    assert.ok(init?.signal instanceof AbortSignal);
    return wavResponse(wav);
  });
  assert.equal((await getQwen3TtsConfiguration()).provider, "qwen3-tts-mlx");
  const result = await synthesizeWithQwen3Tts({ text: "테스트", speaker: "Sohee", language: "Japanese" });
  assert.equal(result.provider, "qwen3-tts-mlx");
  assert.equal(result.sampleRate, 24000);
  assert.equal(result.durationSec, 0.25);
  assert.deepEqual(result.audio, wav);
  assert.deepEqual(timeouts, [1800, 300000]);
});

test("actual stereo PCM samples determine timing even when HTTP metadata is nonfinite or incorrect", async (t) => {
  t.mock.method(globalThis, "fetch", async () => wavResponse(spokenWav(48000, 2), {
    "x-duration-seconds": "NaN",
    "x-sample-rate": "Infinity"
  }));
  const result = await synthesizeWithQwen3Tts({ text: "측정" });
  assert.equal(result.durationSec, 0.25);
  assert.equal(result.sampleRate, 48000);
});

test("WAV parser handles padded metadata chunks and a byte-offset view", () => {
  const original = spokenWav();
  const withJunk = new Uint8Array(original.length + 10);
  withJunk.set(original.subarray(0, 12));
  withJunk.set([74, 85, 78, 75, 1, 0, 0, 0, 42, 0], 12);
  withJunk.set(original.subarray(12), 22);
  new DataView(withJunk.buffer).setUint32(4, withJunk.length - 8, true);
  const backing = new Uint8Array(withJunk.length + 8);
  backing.set(withJunk, 4);
  const result = readPcm16Wav(backing.subarray(4, 4 + withJunk.length));
  assert.equal(result.sampleFrames, 6000);
  assert.equal(result.durationSec, 0.25);
  assert.equal(result.hasNonZeroSamples, true);
});

test("synthesis rejects non-audio and malformed or unusable WAV responses", async (t) => {
  const truncated = spokenWav().slice(0, -2);
  new DataView(truncated.buffer).setUint32(4, truncated.length - 8, true);
  const wrongLayout = spokenWav();
  new DataView(wrongLayout.buffer).setUint32(28, 1, true);
  const floatNaN = pcm16ToWav(new Uint8Array(4), 24000);
  const floatHeader = new DataView(floatNaN.buffer);
  floatHeader.setUint16(20, 3, true);
  floatHeader.setUint16(34, 32, true);
  floatHeader.setUint16(32, 4, true);
  floatHeader.setUint32(28, 96000, true);
  floatHeader.setFloat32(44, NaN, true);
  const cases: Array<[string, () => Response]> = [
    ["HTML instead of audio", () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } })],
    ["four-byte RIFF prefix", () => wavResponse(new Uint8Array([82, 73, 70, 70]))],
    ["truncated PCM payload", () => wavResponse(truncated)],
    ["zero sample rate", () => wavResponse(pcm16ToWav(new Uint8Array([1, 0]), 0))],
    ["zero sample frames", () => wavResponse(pcm16ToWav(new Uint8Array(), 24000))],
    ["all-zero PCM", () => wavResponse(pcm16ToWav(new Uint8Array(480), 24000))],
    ["invalid byte rate", () => wavResponse(wrongLayout)],
    ["nonfinite float WAV", () => wavResponse(floatNaN)],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async (child) => {
      child.mock.method(globalThis, "fetch", async () => response());
      await assert.rejects(synthesizeWithQwen3Tts({ text: "검사" }));
    });
  }
});

test("upstream HTTP and timeout errors propagate instead of returning scene metadata", async (t) => {
  await t.test("HTTP failure", async (child) => {
    child.mock.method(globalThis, "fetch", async () => new Response("synthesis failed", { status: 503 }));
    await assert.rejects(synthesizeWithQwen3Tts({ text: "검사" }), /503/);
  });
  await t.test("timeout", async (child) => {
    child.mock.method(globalThis, "fetch", async () => { throw new DOMException("Timed out", "TimeoutError"); });
    await assert.rejects(synthesizeWithQwen3Tts({ text: "검사" }), { name: "TimeoutError" });
  });
});
