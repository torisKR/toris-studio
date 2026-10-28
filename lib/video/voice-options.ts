/** Closed voice choices shared with Rust (media::voice_options) and runtime/narration.py. */
export const VOICE_SPEAKERS = {
  Sohee: "Sohee · 한국어 여성", Ryan: "Ryan · 남성", Aiden: "Aiden · 남성", Vivian: "Vivian · 여성", Serena: "Serena · 여성",
  Uncle_Fu: "Uncle_Fu · 남성", Dylan: "Dylan · 남성", Eric: "Eric · 남성", Ono_Anna: "Ono_Anna · 여성"
} as const;
export const VOICE_STYLES = {
  natural: "자연스럽게", documentary: "차분한 다큐", "tech-news": "IT 뉴스", shorts: "활기찬 쇼츠",
  story: "감성 스토리", commercial: "광고·제품 소개", emphasis: "강조", whisper: "속삭이듯"
} as const;
export const VOICE_EMPHASIS = { subtle: "은은하게", normal: "보통", strong: "강하게" } as const;
export const VOICE_QUALITY = { stable: "안정 · 나레이션 추천", standard: "표준", expressive: "표현력 · 다이내믹" } as const;

export type VoiceSettings = {
  speaker?: keyof typeof VOICE_SPEAKERS;
  style?: keyof typeof VOICE_STYLES;
  emphasis?: keyof typeof VOICE_EMPHASIS;
  quality?: keyof typeof VOICE_QUALITY;
  pauseMs?: number;
};
export const DEFAULT_VOICE: Required<VoiceSettings> = { speaker: "Sohee", style: "natural", emphasis: "normal", quality: "stable", pauseMs: 300 };

const TAG_ALIASES = ["뉴스·정보", "자연스러운 설명", "활기찬 소개", "속삭임"];
const KNOWN_TAGS = new Set<string>([
  ...Object.keys(VOICE_STYLES), ...Object.values(VOICE_STYLES), ...TAG_ALIASES,
  ...Object.keys(VOICE_SPEAKERS).map(name => name.toLowerCase())
]);

function knownTag(token: string) {
  const value = token.trim();
  if (KNOWN_TAGS.has(value) || KNOWN_TAGS.has(value.toLowerCase())) return true;
  if (/^쉼:\s*\d+$/.test(value)) return true;
  const named = value.match(/^(?:speaker|화자)\s*:\s*(.+)$/i);
  return Boolean(named && KNOWN_TAGS.has(named[1].trim().toLowerCase()));
}

/** Text a viewer hears: drops the narration tags ([톤] [화자] [쉼:ms]) and **강조** markers. */
export function spokenNarration(script: string): string {
  return script.split("\n").map(raw => {
    let line = raw.trim();
    for (let found = line.match(/^\[([^\]\n]{1,60})\]\s*/); found && knownTag(found[1]); found = line.match(/^\[([^\]\n]{1,60})\]\s*/)) {
      line = line.slice(found[0].length);
    }
    return line.replace(/\*\*(.+?)\*\*/g, "$1").trim();
  }).filter(Boolean).join("\n");
}

