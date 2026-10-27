// Run trace: one JSON line per step, so a run can be replayed and compared in evals.
export type TraceEntry =
  | { kind: "model"; role: string; ms: number; ok: boolean }
  | { kind: "event"; agent: string; phase: string; message: string }
  | { kind: "approval"; id: string; agent: string; action: string; decision?: string }
  | { kind: "command"; argv: string[]; exit: number | null; ms: number };

export class Trace {
  readonly entries: Array<TraceEntry & { at: number }> = [];
  private started = Date.now();
  add(entry: TraceEntry): void {
    this.entries.push({ ...entry, at: Date.now() - this.started });
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000);
  }
  jsonl(): string {
    return this.entries.map(entry => JSON.stringify(entry)).join("\n");
  }
}
