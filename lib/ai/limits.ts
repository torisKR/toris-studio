import { AiError } from "./types";

/** One local owner: a global bounded limiter avoids spoofed client/IP identifiers. */
export class GenerationLimiter {
  private requests: number[] = [];
  private active = 0;
  constructor(private readonly clock: () => number = Date.now) {}
  acquire(): () => void {
    const now = this.clock();
    this.requests = this.requests.filter((time) => time > now - 60000);
    if (this.active >= 2) throw new AiError("AI_BUSY", "AI가 이미 두 개의 초안을 작성 중입니다. 완료 후 다시 시도해 주세요.", 429);
    if (this.requests.length >= 5) throw new AiError("AI_RATE_LIMITED", "초안 생성은 분당 5회까지 가능합니다. 잠시 후 다시 시도해 주세요.", 429);
    this.requests.push(now);
    this.active += 1;
    let released = false;
    return () => { if (!released) { this.active -= 1; released = true; } };
  }
}
