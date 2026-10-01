export type Qwen3TtsOptions = {
  text: string;
  speaker?: string;
  language?: string;
  instruct?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:50010";

function baseUrl() {
  return (process.env.QWEN_TTS_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/$/,
    ""
  );
}

export async function getQwen3TtsConfiguration() {
  const url = baseUrl();

  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1800),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const health = (await response.json()) as {
      ok?: boolean;
      model?: string;
      speaker?: string;
      language?: string;
    };

    return {
      configured: health.ok === true,
      provider: "qwen3-tts-mlx",
      model: health.model ?? null,
      speaker: health.speaker ?? null,
      language: health.language ?? null,
      reason: health.ok === true ? null : "Qwen3-TTS 서버 응답이 비정상입니다."
    };
  } catch {
    return {
      configured: false,
      provider: "qwen3-tts-mlx",
      model: null,
      speaker: null,
      language: null,
      reason:
        "로컬 Qwen3-TTS 서버가 실행 중이 아닙니다. bash scripts/start-qwen3-tts-macos.sh 를 실행하세요."
    };
  }
}

export async function synthesizeWithQwen3Tts(options: Qwen3TtsOptions) {
  const response = await fetch(`${baseUrl()}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: options.text,
      speaker:
        options.speaker ?? process.env.QWEN_TTS_SPEAKER?.trim() ?? "Sohee",
      language:
        options.language ?? process.env.QWEN_TTS_LANGUAGE?.trim() ?? "Korean",
      instruct:
        options.instruct ??
        process.env.QWEN_TTS_INSTRUCT?.trim() ??
        "따뜻하고 자연스러운 한국 여성 목소리. 실제 사람이 말하듯 편안하고 부드럽게, 광고처럼 과장하지 말고 문장마다 자연스럽게 호흡하며 또렷하게 말한다.",
      temperature: options.temperature ?? 0.85,
      top_p: options.topP ?? 0.95,
      top_k: options.topK ?? 50,
      repetition_penalty: options.repetitionPenalty ?? 1.05,
      max_tokens: options.maxTokens ?? 4096
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Qwen3-TTS request failed: ${response.status} ${detail.slice(0, 800)}`
    );
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  const durationSec = Number(
    response.headers.get("x-duration-seconds") ?? "0"
  );
  const sampleRate = Number(response.headers.get("x-sample-rate") ?? "24000");
  const speaker =
    response.headers.get("x-tts-speaker") ??
    options.speaker ??
    process.env.QWEN_TTS_SPEAKER ??
    "Sohee";

  return {
    audio,
    format: "wav" as const,
    durationSec,
    sampleRate,
    speaker,
    provider: "qwen3-tts-mlx" as const
  };
}
