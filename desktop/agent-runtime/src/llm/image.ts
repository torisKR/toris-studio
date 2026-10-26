import type { RuntimeSettings } from "../protocol.js";
import { UserError } from "../util.js";
import { postJson } from "./http.js";

export type ImageResult = { base64: string; mime: string; provider: string; model: string };
const SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

/** Image generation is API-only: subscription CLIs cannot return image bytes reliably. */
export async function generateImage(settings: RuntimeSettings, prompt: string, size: string, signal?: AbortSignal): Promise<ImageResult> {
  const choice = settings.image;
  if (!choice) throw new UserError("Agent 설정에서 이미지 생성 모델(OpenAI 또는 Google)을 선택하세요.");
  if (!prompt.trim() || prompt.length > 32_000) throw new UserError("이미지 프롬프트를 확인하세요.");
  if (choice.provider === "openai") {
    const key = settings.keys.openai;
    if (!key) throw new UserError("이미지 생성에 OpenAI API 키가 필요합니다.");
    const value = await postJson(
      { url: "https://api.openai.com/v1/images/generations", headers: { authorization: `Bearer ${key}` } },
      { model: choice.model || "gpt-image-1", prompt, size: SIZES.has(size) ? size : "1024x1024", n: 1 },
      [key], signal,
    );
    const b64 = (value.data as Array<{ b64_json?: string }> | undefined)?.[0]?.b64_json;
    if (!b64) throw new UserError("OpenAI가 이미지 데이터를 반환하지 않았습니다.");
    return { base64: b64, mime: "image/png", provider: "openai", model: choice.model || "gpt-image-1" };
  }
  const key = settings.keys.google;
  if (!key) throw new UserError("이미지 생성에 Google Gemini API 키가 필요합니다.");
  const model = choice.model || "gemini-2.5-flash-image";
  const value = await postJson(
    { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, headers: { "x-goog-api-key": key } },
    { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"] } },
    [key], signal,
  );
  const parts = (value.candidates as Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> | undefined)?.[0]?.content?.parts ?? [];
  const image = parts.find(part => part.inlineData?.data)?.inlineData;
  if (!image?.data) throw new UserError("Gemini가 이미지 데이터를 반환하지 않았습니다.");
  return { base64: image.data, mime: image.mimeType || "image/png", provider: "google", model };
}
