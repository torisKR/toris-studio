"""Narration markup and voice presets for the local Qwen3-TTS runtime.

Ported from MLX-Narration (studio_v2/engine.py): speakers, tones, emphasis,
quality presets and the [tone] [speaker] [쉼:ms] **stress** script tags.
Pure standard library so it can be tested without MLX.
"""
from __future__ import annotations

from dataclasses import dataclass
import re

VERSION = 1

# id -> (label, model speaker name). Qwen3-TTS CustomVoice built-in speakers.
SPEAKERS = {
    "Sohee": "Sohee · 한국어 여성",
    "Ryan": "Ryan · 남성",
    "Aiden": "Aiden · 남성",
    "Vivian": "Vivian · 여성",
    "Serena": "Serena · 여성",
    "Uncle_Fu": "Uncle_Fu · 남성",
    "Dylan": "Dylan · 남성",
    "Eric": "Eric · 남성",
    "Ono_Anna": "Ono_Anna · 여성",
}
# id -> (Korean label used in script tags, instruction prompt).
STYLES = {
    "natural": ("자연스럽게", "Speak naturally with realistic conversational prosody, expressive yet controlled, clear but not exaggerated."),
    "documentary": ("차분한 다큐", "Warm documentary narration, measured pace, reflective, smooth low-key intonation, clear pauses."),
    "tech-news": ("IT 뉴스", "Professional technology news anchor. Confident, crisp, engaged and accurate, dynamic but never shouty."),
    "shorts": ("활기찬 쇼츠", "Lively upbeat short-form video narrator. Fast-moving expressive intonation, engaging and friendly, not overacted."),
    "story": ("감성 스토리", "Warm heartfelt storytelling, sincere and intimate, emotion is gentle and authentic."),
    "commercial": ("광고·제품 소개", "Premium product commercial voiceover, bright clear diction, persuasive and engaging but natural."),
    "emphasis": ("강조", "Emphasize the main points convincingly. Add meaningful changes of pitch, energy and deliberate pauses without shouting."),
    "whisper": ("속삭이듯", "Very soft, intimate, gentle delivery, airy and quiet with careful articulation."),
}
STYLE_ALIASES = {"뉴스·정보": "tech-news", "자연스러운 설명": "natural", "활기찬 소개": "shorts", "속삭임": "whisper"}
EMPHASIS = {
    "subtle": "subtly and naturally",
    "normal": "clearly, but with natural restraint",
    "strong": "more expressively, with meaningful stress but without yelling",
}
# Lower temperature keeps pronunciation stable; repetition_penalty suppresses mumbling.
QUALITY = {
    "stable": dict(temperature=0.7, top_p=0.9, top_k=40, repetition_penalty=1.1),
    "standard": dict(temperature=0.9, top_p=1.0, top_k=50, repetition_penalty=1.05),
    "expressive": dict(temperature=1.0, top_p=0.95, top_k=60, repetition_penalty=1.0),
}
MAX_LINE = 320
MAX_SEGMENTS = 60
MAX_PAUSE_MS = 2000

_TAG = re.compile(r"^\[([^\]\n]{1,60})\]\s*")
_SPEAKER_TAG = re.compile(r"^(?:speaker|화자)\s*:\s*(.+)$", re.IGNORECASE)
_MARKUP = re.compile(r"\*\*(.+?)\*\*")
_SENTENCE = re.compile(r"(?<=[.!?。！？])\s+")
_STYLE_BY_TOKEN = {label: key for key, (label, _) in STYLES.items()} | {key: key for key in STYLES} | STYLE_ALIASES
_SPEAKER_BY_TOKEN = {name.lower(): name for name in SPEAKERS}


@dataclass(frozen=True)
class Segment:
    text: str
    speaker: str
    style: str
    highlights: tuple[str, ...]
    pause_ms: int


def _split_long(text: str) -> list[str]:
    if len(text) <= MAX_LINE:
        return [text]
    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE.split(text):
        while len(sentence) > MAX_LINE:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(sentence[:MAX_LINE])
            sentence = sentence[MAX_LINE:].lstrip()
        if current and len(current) + 1 + len(sentence) > MAX_LINE:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks


def parse(script: str, speaker: str, style: str, pause_ms: int) -> list[Segment]:
    """Split a script into spoken segments. Unknown tags stay as spoken text."""
    if speaker not in SPEAKERS:
        raise ValueError(f"Unknown speaker: {speaker}")
    if style not in STYLES:
        raise ValueError(f"Unknown style: {style}")
    if not 0 <= pause_ms <= MAX_PAUSE_MS:
        raise ValueError("pause_ms must be between 0 and 2000.")
    segments: list[Segment] = []
    for raw in script.splitlines():
        line = raw.strip()
        voice, tone, pause = speaker, style, pause_ms
        while (found := _TAG.match(line)):
            token = found.group(1).strip()
            if token in _STYLE_BY_TOKEN:
                tone = _STYLE_BY_TOKEN[token]
            elif token.lower() in _SPEAKER_BY_TOKEN:
                voice = _SPEAKER_BY_TOKEN[token.lower()]
            elif (named := _SPEAKER_TAG.match(token)) and named.group(1).strip().lower() in _SPEAKER_BY_TOKEN:
                voice = _SPEAKER_BY_TOKEN[named.group(1).strip().lower()]
            elif token.startswith("쉼:") and token[2:].strip().isdigit():
                pause = min(int(token[2:].strip()), MAX_PAUSE_MS)
            else:
                break
            line = line[found.end():].strip()
        highlights = tuple(_MARKUP.findall(line))
        spoken = _MARKUP.sub(r"\1", line).strip()
        if not spoken:
            continue
        parts = _split_long(spoken)
        for index, part in enumerate(parts):
            terms = tuple(term for term in highlights if term in part)
            segments.append(Segment(part, voice, tone, terms, pause if index == len(parts) - 1 else 120))
    if not segments:
        raise ValueError("The script has no spoken text.")
    if len(segments) > MAX_SEGMENTS:
        raise ValueError(f"A script can hold at most {MAX_SEGMENTS} segments.")
    return segments


def instruction(segment: Segment, emphasis: str, extra: str = "") -> str:
    if emphasis not in EMPHASIS:
        raise ValueError(f"Unknown emphasis: {emphasis}")
    prompt = STYLES[segment.style][1]
    if segment.highlights:
        prompt += f" Pronounce and stress these words {EMPHASIS[emphasis]}: {', '.join(segment.highlights)}."
    if extra.strip():
        prompt += " " + extra.strip()[:350]
    return prompt


def sampling(quality: str) -> dict:
    if quality not in QUALITY:
        raise ValueError(f"Unknown quality preset: {quality}")
    return dict(QUALITY[quality])

