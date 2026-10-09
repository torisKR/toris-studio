import { claudeSubscriptionStatus, generateWithClaudeCli, runClaudeCli, type CliRunner } from "./claude-cli";
import { localGatewayUrl, readAiConfig, validModel, type AiConfig, type GatewayConfig } from "./config";
import { GenerationLimiter } from "./limits";
import { draftMessages } from "./prompts";
import { gatewayFetch } from "./transport";
import { AiError, type AiProviderId, type DraftInput, type DraftResult, type ProviderStatus } from "./types";

function catalogModels(value: unknown): string[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 모델 목록을 읽을 수 없습니다.", 502);
  }
  return ((value as { data: unknown[] }).data).flatMap((item) => {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    return typeof id === "string" && validModel(id) ? [id] : [];
  }).slice(0, 1000);
}

function completionText(value: unknown): string {
  if (!value || typeof value !== "object") throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 초안이 비어 있습니다.", 502);
  const data = value as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown[] } }> };
  const choice = data.choices?.[0];
  // Even a misconfigured provider cannot turn a draft request into a tool workflow.
  if (choice?.message?.tool_calls?.length) throw new AiError("PROVIDER_TOOLS_REJECTED", "AI 도구 호출은 초안 생성에서 허용되지 않습니다.", 502);
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim() || content.length > 40000) {
    throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 제공자가 올바른 텍스트 초안을 반환하지 않았습니다.", 502);
  }
  if (choice?.finish_reason === "length") throw new AiError("PROVIDER_RESPONSE_TRUNCATED", "AI 초안이 길이 제한으로 중단되었습니다. 주제를 좁혀 다시 시도해 주세요.", 502);
  return content.trim();
}

export class AiService {
  private readonly verified = new Set<AiProviderId>();
  constructor(
    private readonly getConfig: () => AiConfig = readAiConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cliRunner: CliRunner = runClaudeCli,
    private readonly limiter: GenerationLimiter = new GenerationLimiter(),
  ) {}

  private async gatewayStatus(config: GatewayConfig): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: config.id, label: config.label, configured: Boolean(config.baseUrl), available: false,
      reachable: false, authenticated: null, generationVerified: this.verified.has(config.id),
      detail: "로컬 게이트웨이를 설정해 주세요.",
    };
    if (!config.baseUrl) return base;
    try {
      const url = localGatewayUrl(config.baseUrl);
      if (!validModel(config.model) || !config.allowedModels.includes(config.model)) {
        throw new AiError("INVALID_PROVIDER_CONFIG", "기본 AI 모델과 허용 모델 목록을 확인해 주세요.");
      }
      const catalog = catalogModels(await gatewayFetch(this.fetcher, `${url}/models`, config.apiKey, 3000));
      const models = config.allowedModels.filter((model) => catalog.includes(model));
      return {
        ...base, reachable: true, available: models.length > 0, models,
        authenticated: this.verified.has(config.id) ? true : null,
        detail: models.length === 0 ? "게이트웨이에 연결했지만 허용한 모델을 찾을 수 없습니다."
          : this.verified.has(config.id) ? "연결됨 · 이 서버에서 실제 초안 생성 확인됨"
          : "모델 목록 연결됨 · 실제 생성과 구독 인증은 아직 확인하지 않았습니다.",
      };
    } catch (error) {
      return { ...base, reachable: error instanceof AiError && ["PROVIDER_AUTH_REQUIRED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(error.code),
        authenticated: error instanceof AiError && error.code === "PROVIDER_AUTH_REQUIRED" ? false : null,
        detail: error instanceof AiError ? error.message : "로컬 AI 연결 상태를 확인해 주세요." };
    }
  }

  async status(): Promise<{ providers: ProviderStatus[]; defaultProvider: AiProviderId | null }> {
    const config = this.getConfig();
    const providers = await Promise.all(config.gateways.map((gateway) => this.gatewayStatus(gateway)));
    const cli = config.claudeCli;
    const authenticated = cli.enabled ? await claudeSubscriptionStatus(cli.command, this.cliRunner) : false;
    providers.push({
      id: "claude-cli", label: "Claude Code 구독", configured: cli.enabled, available: authenticated,
      reachable: authenticated, authenticated: cli.enabled ? authenticated : null,
      generationVerified: this.verified.has("claude-cli"), models: authenticated ? [cli.model] : [],
      detail: !cli.enabled ? "선택 설정 · 공식 Claude Code 구독 로그인이 필요합니다."
        : authenticated ? (this.verified.has("claude-cli") ? "구독 로그인 및 실제 생성 확인됨" : "구독 로그인 확인됨 · 실제 생성 미확인")
        : "Claude Code 구독 로그인을 확인할 수 없습니다. 터미널에서 로그인 상태를 확인해 주세요.",
    });
    // Never silently switch accounts, gateways or billing sources.
    return { providers, defaultProvider: providers.some((provider) => provider.id === config.defaultProvider && provider.available) ? config.defaultProvider : null };
  }

  async generate(input: DraftInput): Promise<DraftResult> {
    const config = this.getConfig();
    const provider = input.provider || config.defaultProvider;
    if (provider === "claude-cli") {
      const cli = config.claudeCli;
      if (!cli.enabled) throw new AiError("PROVIDER_NOT_CONFIGURED", "Claude Code 구독 사용 설정이 필요합니다.");
      if (!validModel(cli.model) || (input.model && input.model !== cli.model)) throw new AiError("MODEL_NOT_ALLOWED", "허용하지 않은 AI 모델입니다.", 400);
      const release = this.limiter.acquire();
      try {
        if (!await claudeSubscriptionStatus(cli.command, this.cliRunner)) throw new AiError("PROVIDER_AUTH_REQUIRED", "Claude Code의 공식 구독 로그인이 필요합니다.");
        const text = await generateWithClaudeCli(cli.command, cli.model, input, config.timeoutMs, this.cliRunner);
        this.verified.add(provider);
        return { text, provider, model: cli.model };
      } finally { release(); }
    }
    const gateway = config.gateways.find((candidate) => candidate.id === provider);
    if (!gateway?.baseUrl) throw new AiError("PROVIDER_NOT_CONFIGURED", "로컬 AI 제공자를 설정해 주세요.");
    const baseUrl = localGatewayUrl(gateway.baseUrl);
    const model = input.model || gateway.model;
    if (!validModel(model) || !gateway.allowedModels.includes(model)) throw new AiError("MODEL_NOT_ALLOWED", "허용하지 않은 AI 모델입니다.", 400);
    const release = this.limiter.acquire();
    try {
      const response = await gatewayFetch(this.fetcher, `${baseUrl}/chat/completions`, gateway.apiKey, config.timeoutMs, {
        method: "POST", body: JSON.stringify({ model, messages: draftMessages(input), stream: false, tools: [], max_completion_tokens: 2200 }),
      });
      const text = completionText(response);
      this.verified.add(provider);
      return { text, provider, model };
    } finally { release(); }
  }
}

// Resolve globals at request time so Next dev reloads and configuration changes are respected.
const globalAi = globalThis as typeof globalThis & { torisAiService?: AiService };
export function aiService(): AiService {
  globalAi.torisAiService ||= new AiService(readAiConfig, (...args) => fetch(...args));
  return globalAi.torisAiService;
}
