type SttProvider = "whisper_cpp" | "openai_compatible";

function getProvider(): SttProvider {
  const value = process.env.STT_PROVIDER ?? "whisper_cpp";
  return value === "openai_compatible" ? value : "whisper_cpp";
}

export async function transcribeLocalAudio(input: {
  file: Blob;
  fileName: string;
  language?: string;
}) {
  const baseUrl = (
    process.env.STT_BASE_URL ?? "http://127.0.0.1:8080"
  ).replace(/\/$/, "");
  const provider = getProvider();
  const form = new FormData();

  form.set("file", input.file, input.fileName);

  if (provider === "whisper_cpp") {
    form.set("response_format", "text");
    if (input.language) form.set("language", input.language);

    const response = await fetch(`${baseUrl}/inference`, {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      throw new Error(
        `whisper.cpp failed: ${response.status} ${await response.text()}`
      );
    }

    const text = (await response.text()).trim();
    if (!text) throw new Error("whisper.cpp returned no transcript.");
    return text;
  }

  form.set("model", process.env.STT_MODEL ?? "local");
  if (input.language) form.set("language", input.language);

  const apiKey = process.env.STT_API_KEY;
  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    body: form
  });

  if (!response.ok) {
    throw new Error(
      `Local STT failed: ${response.status} ${await response.text()}`
    );
  }

  const data = (await response.json()) as {
    text?: string;
    transcription?: string;
  };

  const text = data.text ?? data.transcription;
  if (!text) throw new Error("Local STT returned no transcript.");

  return text.trim();
}
