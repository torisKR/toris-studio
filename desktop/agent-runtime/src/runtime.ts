import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import { RunHistory } from "./graph/history.js";
import { RunManager } from "./graph/runs.js";
import { createModel, isProvider, listModels, providerStatus } from "./llm/index.js";
import { defaultSearchPath } from "./llm/cli.js";
import { generateImage } from "./llm/image.js";
import { listProjects } from "./projects.js";
import type { ModelChoice, OutboundEvent, Request, Response, RuntimeSettings } from "./protocol.js";
import { ChromaClient } from "./rag/chroma.js";
import { ProjectIndex } from "./rag/index.js";
import { UserError, errorText, record, redact, text } from "./util.js";

export const VERSION = "0.1.0";
const MAX_LINE = 2 * 1024 * 1024;

export function defaultSettings(): RuntimeSettings {
  return {
    projectsRoot: path.join(homedir(), "projects"),
    historyDir: "",
    chromaUrl: "http://127.0.0.1:18765",
    searchPath: defaultSearchPath(),
    keys: {},
    ollamaUrl: "http://127.0.0.1:11434",
    agentModel: null,
    contentModel: null,
    image: null,
    embedding: { provider: "local", model: "" },
  };
}

function choice(value: unknown): ModelChoice | null {
  if (!value) return null;
  const v = record(value, "모델 선택");
  if (!isProvider(v.provider)) throw new UserError("지원하지 않는 모델 공급자입니다.");
  return { provider: v.provider, model: text(v.model, "모델 이름", 200, { optional: true }) };
}

export function parseSettings(raw: unknown): RuntimeSettings {
  const v = record(raw, "설정");
  const base = defaultSettings();
  const keys = record(v.keys ?? {}, "API 키");
  const embedding = record(v.embedding ?? base.embedding, "임베딩 설정");
  const image = v.image ? record(v.image, "이미지 설정") : null;
  const embeddingProvider = String(embedding.provider ?? "local");
  if (!["local", "openai", "google", "ollama"].includes(embeddingProvider)) throw new UserError("임베딩 공급자를 확인하세요.");
  if (image && !["openai", "google"].includes(String(image.provider))) throw new UserError("이미지 공급자를 확인하세요.");
  const projectsRoot = text(v.projectsRoot ?? base.projectsRoot, "프로젝트 폴더", 1000);
  if (!path.isAbsolute(projectsRoot)) throw new UserError("프로젝트 폴더는 절대 경로여야 합니다.");
  const historyDir = text(v.historyDir ?? "", "작업 기록 폴더", 1000, { optional: true });
  if (historyDir && !path.isAbsolute(historyDir)) throw new UserError("작업 기록 폴더는 절대 경로여야 합니다.");
  return {
    projectsRoot,
    historyDir,
    chromaUrl: text(v.chromaUrl ?? base.chromaUrl, "ChromaDB 주소", 200),
    searchPath: Array.isArray(v.searchPath) ? [...v.searchPath.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)).slice(0, 40), ...base.searchPath] : base.searchPath,
    keys: Object.fromEntries(["anthropic", "openai", "google", "openrouter"].flatMap(k => (typeof keys[k] === "string" && keys[k] ? [[k, (keys[k] as string).trim()]] : []))),
    ollamaUrl: text(v.ollamaUrl ?? base.ollamaUrl, "Ollama 주소", 200),
    agentModel: choice(v.agentModel),
    contentModel: choice(v.contentModel),
    image: image ? { provider: image.provider as "openai" | "google", model: text(image.model, "이미지 모델", 200, { optional: true }) } : null,
    embedding: { provider: embeddingProvider as RuntimeSettings["embedding"]["provider"], model: text(embedding.model, "임베딩 모델", 200, { optional: true }) },
  };
}

export class Runtime {
  settings = defaultSettings();
  private indexing = new Map<string, AbortController>();
  private historyDir = "";
  readonly runs: RunManager;
  constructor(private out: (event: OutboundEvent) => void) {
    this.runs = new RunManager(() => this.settings, event => this.out(event));
  }
  private secrets() { return Object.values(this.settings.keys).filter((v): v is string => Boolean(v)); }

  async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    switch (method) {
      case "configure": {
        this.settings = parseSettings(params);
        if (this.settings.historyDir && this.settings.historyDir !== this.historyDir) {
          this.historyDir = this.settings.historyDir;
          this.runs.attachHistory(new RunHistory(this.historyDir));
        }
        return { ok: true };
      }
      case "status": return { version: VERSION, providers: await providerStatus(this.settings), chroma: await new ChromaClient(this.settings.chromaUrl).heartbeat(), projectsRoot: this.settings.projectsRoot };
      case "models.list": if (!isProvider(p.provider)) throw new UserError("공급자를 확인하세요."); return { models: await listModels(p.provider, this.settings) };
      case "projects.list": return { projects: listProjects(this.settings.projectsRoot) };
      case "index.status": return new ProjectIndex(this.settings).status(text(p.project, "프로젝트", 200));
      case "index.build": return this.buildIndex(text(p.project, "프로젝트", 200));
      case "index.cancel": this.indexing.get(text(p.project, "프로젝트", 200))?.abort(); return { ok: true };
      case "search": return { hits: await new ProjectIndex(this.settings).search(text(p.project, "프로젝트", 200), text(p.query, "검색어", 2000), Number(p.k) || 8) };
      case "run.start": return this.runs.start(text(p.project, "프로젝트", 200), text(p.task, "작업", 20_000));
      case "run.resume": return this.runs.resume(text(p.runId, "작업 ID", 100), { actionId: text(p.actionId, "승인 ID", 100), decision: p.decision === "approve" ? "approve" : "reject", feedback: text(p.feedback, "피드백", 2000, { optional: true }) });
      case "run.cancel": return this.runs.cancel(text(p.runId, "작업 ID", 100));
      case "run.list": return { runs: this.runs.list() };
      case "run.get": return this.runs.get(text(p.runId, "작업 ID", 100));
      case "complete": {
        const model = createModel(p.purpose === "agent" ? this.settings.agentModel : this.settings.contentModel ?? this.settings.agentModel, this.settings);
        const output = await model.complete({ system: text(p.system, "시스템 지시", 20_000, { optional: true }) || "너는 Toris Studio의 콘텐츠 작성 도우미다. 확인하지 않은 사실을 단정하지 않는다.", messages: [{ role: "user", content: text(p.prompt, "요청", 60_000) }], maxTokens: Number(p.maxTokens) || undefined });
        return { text: output, provider: model.provider, model: model.model };
      }
      case "image": return generateImage(this.settings, text(p.prompt, "이미지 프롬프트", 32_000), String(p.size ?? "1024x1024"));
      default: throw new UserError(`알 수 없는 요청입니다: ${method}`);
    }
  }

  private buildIndex(project: string): { started: boolean } {
    if (this.indexing.has(project)) throw new UserError("이미 색인 중입니다.");
    const controller = new AbortController();
    this.indexing.set(project, controller);
    const index = new ProjectIndex(this.settings);
    void index.build(project, (phase, done, total, message) => this.out({ event: "index", project, phase, done, total, message }), controller.signal)
      .catch(error => this.out({ event: "index", project, phase: "failed", done: 0, total: 0, message: redact(errorText(error), this.secrets()) }))
      .finally(() => this.indexing.delete(project));
    return { started: true };
  }

  shutdown(): void {
    this.runs.shutdown();
    for (const controller of this.indexing.values()) controller.abort();
  }
}

export function serve(): void {
  const write = (value: Response | OutboundEvent) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const runtime = new Runtime(write);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", line => {
    if (line.length > MAX_LINE) return write({ event: "log", level: "error", message: "요청이 너무 큽니다." });
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { return write({ event: "log", level: "error", message: "잘못된 요청 형식입니다." }); }
    if (typeof request?.id !== "string" || typeof request.method !== "string") return write({ event: "log", level: "error", message: "요청 id/method가 필요합니다." });
    if (request.method === "shutdown") { runtime.shutdown(); write({ id: request.id, ok: true, result: { ok: true } }); setTimeout(() => process.exit(0), 50); return; }
    runtime.handle(request.method, request.params)
      .then(result => write({ id: request.id, ok: true, result }))
      .catch(error => write({ id: request.id, ok: false, error: redact(errorText(error), Object.values(runtime.settings.keys).filter((v): v is string => Boolean(v))) }));
  });
  lines.on("close", () => { runtime.shutdown(); process.exit(0); });
  process.on("unhandledRejection", error => write({ event: "log", level: "error", message: redact(errorText(error)) }));
  write({ event: "ready", version: VERSION });
}
