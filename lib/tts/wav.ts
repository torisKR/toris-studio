export function pcm16ToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels = 1
) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  function writeText(offset: number, value: string) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeText(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}

/** Read the local TTS contract: RIFF/WAVE, uncompressed PCM16, mono or stereo.
 * Float, compressed and WAVE_FORMAT_EXTENSIBLE files are deliberately unsupported.
 * Duration comes from complete PCM sample frames, never an HTTP metadata header.
 */
export function readPcm16Wav(audio: Uint8Array) {
  const invalid = (message: string): never => {
    throw new Error(`Invalid TTS WAV: ${message}`);
  };
  if (audio.byteLength < 12) invalid("truncated RIFF header");
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...audio.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") {
    invalid("expected RIFF/WAVE audio");
  }
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== audio.byteLength) invalid("RIFF size does not match response bytes");

  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let data: { offset: number; bytes: number } | undefined;
  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) invalid("truncated chunk header");
    const kind = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > riffEnd) invalid("truncated chunk payload");
    if (kind === "fmt ") {
      if (format || size < 16) invalid("missing or duplicate PCM format");
      if (view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) {
        invalid("only uncompressed PCM16 is supported");
      }
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      const blockAlign = view.getUint16(start + 12, true);
      if ((channels !== 1 && channels !== 2) || sampleRate <= 0) {
        invalid("expected mono/stereo audio with a positive sample rate");
      }
      if (blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) {
        invalid("inconsistent PCM sample layout");
      }
      format = { channels, sampleRate, blockAlign };
    } else if (kind === "data") {
      if (data) invalid("duplicate audio data chunks");
      data = { offset: start, bytes: size };
    }
    offset = paddedEnd;
  }
  if (!format || !data) return invalid("missing format or audio data");
  if (data.bytes === 0 || data.bytes % format.blockAlign !== 0) {
    invalid("expected nonempty, complete PCM sample frames");
  }
  const sampleFrames = data.bytes / format.blockAlign;
  const durationSec = sampleFrames / format.sampleRate;
  if (!Number.isFinite(durationSec) || durationSec <= 0) invalid("invalid audio duration");
  let hasNonZeroSamples = false;
  for (let i = data.offset; i < data.offset + data.bytes; i += 2) {
    if (view.getInt16(i, true) !== 0) {
      hasNonZeroSamples = true;
      break;
    }
  }
  return { ...format, sampleFrames, durationSec, hasNonZeroSamples };
}
