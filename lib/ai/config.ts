import process from "node:process";
import { AiError, type AiProviderId } from "./types";

export interface GatewayConfig {
  id: "opencodex" | "teamclaude";
  label: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  allowedModels: string[];
}

export interface AiConfig {
  gateways: GatewayConfig[];
  defaultProvider: AiProviderId;
  timeoutMs: number;
  claudeCli: { enabled: boolean; command: string; model: string };
}

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
export function validModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

/** Only a server administrator can configure this URL; browser input never selects a host. */
export function localGatewayUrl(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new AiError("INVALID_PROVIDER_CONFIG", "AI 제공자 주소 설정을 확인해 주세요.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Docker/Orb containers can reach the macOS gateway only through this explicit opt-in.
  const containerHost = env.AI_ALLOW_CONTAINER_HOST === "true"
    && ["host.docker.internal", "host.orb.internal"].includes(url.hostname);
  if ((!loopback && !containerHost) || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") {
    throw new AiError("INVALID_PROVIDER_CONFIG", "AI 주소는 허용된 로컬 호스트의 /v1 경로여야 합니다.");
  }
  return url.toString().replace(/\/$/, "");
}

function gateway(env: NodeJS.ProcessEnv, id: "opencodex" | "teamclaude"): GatewayConfig {
  const prefix = id.toUpperCase();
  const model = env[`${prefix}_MODEL`]?.trim() || (id === "opencodex" ? "gpt-6.1-sol" : "claude-sonnet");
  const allowedModels = (env[`${prefix}_ALLOWED_MODELS`] || model).split(",").map((m) => m.trim()).filter(Boolean);
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim() || (id === "opencodex" ? "http://127.0.0.1:10100/v1" : undefined);
  return {
    id,
    label: id === "opencodex" ? "OpenCodex" : "TeamClaude 로컬 게이트웨이",
    baseUrl,
    apiKey: env[`${prefix}_API_KEY`]?.trim() || undefined,
    model,
    allowedModels: [...new Set(allowedModels.filter(validModel))].slice(0, 32),
  };
}

export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const preferred = env.AI_DEFAULT_PROVIDER;
  const requestedTimeout = Number(env.AI_TIMEOUT_MS || 75000);
  return {
    gateways: [gateway(env, "opencodex"), gateway(env, "teamclaude")],
    defaultProvider: preferred === "teamclaude" || preferred === "claude-cli" ? preferred : "opencodex",
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.min(90000, Math.max(5000, requestedTimeout)) : 75000,
    claudeCli: {
      enabled: env.CLAUDE_CLI_ENABLED === "true",
      command: env.CLAUDE_CLI_PATH || "claude",
      model: env.CLAUDE_CLI_MODEL?.trim() || "sonnet",
    },
  };
}
