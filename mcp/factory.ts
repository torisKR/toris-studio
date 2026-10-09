import { McpServer } from "@modelcontextprotocol/server";
import { registerAssetTools } from "./assets";
import * as z from "zod/v4";
import { createProjectFromTemplate } from "../lib/video/templates";
import { editingPresetSchema, sceneEditingFields } from "../lib/video/editing-schema";

const API_BASE = (
  process.env.TORIS_STUDIO_API_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");

const sceneSchema = z.object({
  ...sceneEditingFields,
  id: z.string().min(1),
  eyebrow: z.string().optional(),
  headline: z.string().min(1),
  body: z.string().default(""),
  narration: z.string().min(1),
  durationSec: z.number().min(1).max(300),
  sourceLabel: z.string().optional(),
  sourceUrl: z.string().optional(),
  mediaType: z
    .enum(["none", "image", "video", "screen"])
    .optional(),
  mediaUrl: z.string().optional(),
  audioPath: z.string().optional(),
  mediaFit: z.enum(["contain", "cover"]).optional(),
  captionCues: z.array(z.object({
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    text: z.string()
  })).optional(),
  accent: z.string().optional(),
  role: z.enum(["hook", "point", "proof", "reaction", "cost", "action", "outro"]).optional(),
  layout: z.enum(["hero", "split", "media-focus", "reaction-grid", "action-card", "social-hook", "social-point", "social-cta"]).optional(),
  badge: z.string().optional()
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const text = await response.text();
  let data: unknown = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;

    throw new Error(`Toris Studio API error: ${message}`);
  }

  return data as T;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function buildStudioMcpServer() {
  const server = new McpServer({
    name: "toris-studio",
    version: "0.1.0"
  });

  server.registerTool(
    "studio_list_projects",
    {
      title: "List Toris Studio projects",
      description:
        "List saved Toris Studio video projects before deciding whether to create or update one.",
      inputSchema: z.object({})
    },
    async () => {
      const data = await api<{ projects: unknown[] }>("/api/projects");
      return textResult(data);
    }
  );

  server.registerTool(
    "studio_create_template_project",
    {
      title: "Create a long-form or Shorts template project",
      description:
        "Create and save an editable Toris Studio project from a built-in format-aware template. Use adaptive-promo for apps, services and brands; use reference-briefing for research, news and comparisons. Shorts and long-form receive different scene structures automatically.",
      inputSchema: z.object({
        template: z.enum(["reference-briefing", "adaptive-promo"]),
        editingPreset: editingPresetSchema.optional(),
        format: z.enum(["youtube-landscape", "vertical", "shorts"]),
        title: z.string().min(1).optional(),
        subtitle: z.string().optional()
      })
    },
    async ({ template, editingPreset, format, title, subtitle }) => {
      const base = createProjectFromTemplate(template, format);
      const body = {
        title: title ?? base.title,
        subtitle: subtitle ?? base.subtitle,
        format: base.format,
        template: base.template,
        editingPreset,
        language: base.language,
        scenes: base.scenes
      };
      const data = await api<{ project: { id: string; title: string } }>(
        "/api/projects",
        { method: "POST", body: JSON.stringify(body) }
      );
      return textResult({
        created: true,
        template,
        format,
        projectId: data.project.id,
        title: data.project.title,
        next: "Refine the scene copy/media with studio_save_project, then generate voice and render."
      });
    }
  );

  server.registerTool(
    "studio_get_project",
    {
      title: "Get a Toris Studio project",
      description:
        "Load a Toris Studio project including its scene script and media metadata.",
      inputSchema: z.object({
        projectId: z.string().uuid()
      })
    },
    async ({ projectId }) => {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
      return textResult(data);
    }
  );

  server.registerTool(
    "studio_save_project",
    {
      title: "Create or save a video project",
      description:
        "Save a complete video plan for preview and review. Each scene should have a concise headline and natural narration. Preserve source URLs. The optional editingPreset project-explainer adds fixed captions, separate aspect layouts and timed UI focus. Use a new projectId or omit it when restyling to preserve the original. mediaSize must be the actual source pixel size; focusRegion uses normalized source coordinates. Never claim unviewed reference styles or draft captions are verified.",
      inputSchema: z.object({
        projectId: z.string().uuid().optional(),
        title: z.string().min(1),
        subtitle: z.string().optional(),
        format: z.enum(["youtube-landscape", "vertical", "shorts"]),
        template: z.enum(["reference-briefing", "adaptive-promo"]).default("reference-briefing"),
        editingPreset: editingPresetSchema.optional(),
        language: z.enum(["ko", "ja", "zh", "en"]).default("ko"),
        scenes: z.array(sceneSchema).min(1).max(120)
      })
    },
    async ({ projectId, title, subtitle, format, template, editingPreset, language, scenes }) => {
      const body = {
        id: projectId,
        title,
        subtitle,
        format,
        template,
        editingPreset,
        language,
        scenes
      };

      const data = await api<{ project: { id: string; title: string } }>(
        "/api/projects",
        {
          method: "POST",
          body: JSON.stringify(body)
        }
      );

      return textResult({
        saved: true,
        projectId: data.project.id,
        title: data.project.title,
        next: "Open Toris Studio to preview, generate voice, or render."
      });
    }
  );

  server.registerTool(
    "studio_generate_scene_voice",
    {
      title: "Generate scene voice with local Qwen3-TTS",
      description:
        "Generate natural Korean narration locally with Qwen3-TTS MLX using the Sohee Korean female voice, then save the audio path and measured duration back into the project.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        sceneId: z.string().min(1)
      })
    },
    async ({ projectId, sceneId }) => {
      const loaded = await api<{
        project: {
          scenes: Array<{
            id: string;
            narration: string;
            durationSec: number;
            audioPath?: string;
          }>;
          [key: string]: unknown;
        };
      }>(`/api/projects/${encodeURIComponent(projectId)}`);

      const scene = loaded.project.scenes.find((item) => item.id === sceneId);
      if (!scene) throw new Error(`Scene not found: ${sceneId}`);

      const voice = await api<{
        audioPath: string;
        durationSec: number;
      }>("/api/tts", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          sceneId,
          text: scene.narration
        })
      });

      const project = {
        ...loaded.project,
        scenes: loaded.project.scenes.map((item) =>
          item.id === sceneId
            ? {
                ...item,
                audioPath: voice.audioPath,
                durationSec: Math.max(
                  1,
                  Number((voice.durationSec + 0.45).toFixed(1))
                )
              }
            : item
        )
      };

      await api(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        body: JSON.stringify(project)
      });

      return textResult({
        generated: true,
        projectId,
        sceneId,
        audioPath: voice.audioPath,
        durationSec: Math.max(
          1,
          Number((voice.durationSec + 0.45).toFixed(1))
        )
      });
    }
  );

  server.registerTool(
    "studio_render_project",
    {
      title: "Render a Toris Studio project",
      description:
        "Render a saved project to H.264 MP4 with Remotion. Use only after the project script and scene timings are ready.",
      inputSchema: z.object({
        projectId: z.string().uuid()
      })
    },
    async ({ projectId }) => {
      const loaded = await api<{ project: unknown }>(
        `/api/projects/${encodeURIComponent(projectId)}`
      );

      const data = await api("/api/render", {
        method: "POST",
        body: JSON.stringify({ project: loaded.project })
      });

      return textResult(data);
    }
  );

  registerAssetTools(server);
  return server;
}
