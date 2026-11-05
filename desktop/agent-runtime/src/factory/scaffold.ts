// Trusted project templates. The model does not write these files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UserError } from "../util.js";
import { assertProjectRelative } from "./artifacts.js";
import { NOTICES } from "./policies.js";
import { VFX_IDS } from "./adapters.js";
import type { FactorySpec } from "./spec.js";
import { SLUG } from "./spec.js";

export const BLENDER_EXPORT_PY = [
  "import json, sys",
  "target = sys.argv[-1]",
  "if target != 'data/models.json':",
  "    raise SystemExit(2)",
  "with open(target, encoding='utf-8') as handle:",
  "    spec = json.load(handle)",
  "budget = spec.get('polygonBudget')",
  "if not isinstance(budget, int) or budget < 1 or budget > 20000:",
  "    raise SystemExit(2)",
  "print('polygon-budget', budget)",
].join("\n") + "\n";

const MAIN_GD = `extends Node2D

var spec: Dictionary = {}
var hp := 3
var xp := 0
var over := false

func _ready() -> void:
	var file := FileAccess.open("res://game.spec.json", FileAccess.READ)
	if file:
		var parsed = JSON.parse_string(file.get_as_text())
		if typeof(parsed) == TYPE_DICTIONARY:
			spec = parsed
	$Label.text = str(spec.get("title", "게임"))

func feature(name: String) -> bool:
	var features = spec.get("features", [])
	return typeof(features) == TYPE_ARRAY and features.has(name)

func _unhandled_input(event: InputEvent) -> void:
	if over:
		return
	if event.is_action_pressed("ui_accept") and feature("combat"):
		xp += 1
	if event.is_action_pressed("ui_cancel") and feature("dodge"):
		hp = max(hp, 1)
	if feature("game-over") and hp <= 0:
		over = true
`;

const MAIN_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Label" type="Label" parent="."]
offset_left = 24.0
offset_top = 24.0
offset_right = 640.0
offset_bottom = 80.0
text = "게임"
`;

const MAIN_ACTIVITY = `package kr.toris.factory

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Screen() }
    }
}

@Composable
fun Screen() {
    Text(text = "앱 화면")
}
`;

function godotQuote(value: string): string {
  return value.replace(/[\\"]/g, "'").replace(/[\r\n]/g, " ").slice(0, 60);
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").slice(0, 40);
}

export function provenanceDocument(template: boolean, provider: string, model: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    template,
    provider: template ? "" : provider,
    model: template ? "" : model,
    commercialUse: "unverified",
    excluded: ["gallery/fonts/Patch Pixel"],
  }, null, 2) + "\n";
}

function designDocument(spec: FactorySpec): string {
  return JSON.stringify({ genre: spec.design.genre, features: spec.features, acceptance: spec.acceptance }, null, 2) + "\n";
}

function charactersDocument(spec: FactorySpec): string {
  const count = spec.assets.characters;
  const characters = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? "hero" : "foe-" + index,
    states: index === 0 ? ["idle", "walk", "attack", "hit", "death"] : ["idle", "walk", "attack"],
  }));
  return JSON.stringify({ characters }, null, 2) + "\n";
}

function vfxDocument(spec: FactorySpec): string {
  return JSON.stringify({ effects: VFX_IDS.slice(0, spec.assets.vfx) }, null, 2) + "\n";
}

function modelsDocument(spec: FactorySpec): string {
  return JSON.stringify({ models: Array.from({ length: spec.assets.models }, (_, index) => ({ id: "model-" + (index + 1), polygonBudget: 5000 })) }, null, 2) + "\n";
}

function godotProject(spec: FactorySpec): string {
  const landscape = spec.design.orientation === "landscape";
  const width = landscape ? 1280 : 720;
  const height = landscape ? 720 : 1280;
  return `; Engine configuration file.
config_version=5

[application]
config/name="${godotQuote(spec.title)}"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.3")

[display]
window/size/viewport_width=${width}
window/size/viewport_height=${height}
`;
}

function filesFor(spec: FactorySpec, template: boolean, provider: string, model: string): Record<string, string> {
  const common = {
    "game.spec.json": JSON.stringify(spec, null, 2) + "\n",
    "THIRD_PARTY_NOTICES": NOTICES + "\n",
    "provenance.json": provenanceDocument(template, provider, model),
    "data/design.json": designDocument(spec),
  };
  if (spec.kind === "app") {
    return {
      ...common,
      "settings.gradle.kts": "rootProject.name = \"factory\"\ninclude(\":app\")\n",
      "build.gradle.kts": "plugins {\n    id(\"com.android.application\") version \"8.7.3\" apply false\n    id(\"org.jetbrains.kotlin.android\") version \"2.0.21\" apply false\n    id(\"org.jetbrains.kotlin.plugin.compose\") version \"2.0.21\" apply false\n}\n",
      "app/build.gradle.kts": "plugins {\n    id(\"com.android.application\")\n    id(\"org.jetbrains.kotlin.android\")\n    id(\"org.jetbrains.kotlin.plugin.compose\")\n}\n\nandroid {\n    namespace = \"kr.toris.factory\"\n    compileSdk = 35\n    defaultConfig {\n        applicationId = \"kr.toris.factory\"\n        minSdk = 26\n        targetSdk = 35\n        versionCode = 1\n        versionName = \"0.1.0\"\n    }\n}\n",
      "app/src/main/AndroidManifest.xml": "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">\n    <application android:label=\"@string/screen_title\" android:theme=\"@android:style/Theme.DeviceDefault.NoActionBar\">\n        <activity android:name=\".MainActivity\" android:exported=\"true\">\n            <intent-filter>\n                <action android:name=\"android.intent.action.MAIN\" />\n                <category android:name=\"android.intent.category.LAUNCHER\" />\n            </intent-filter>\n        </activity>\n    </application>\n</manifest>\n",
      "app/src/main/java/kr/toris/factory/MainActivity.kt": MAIN_ACTIVITY,
      "app/src/main/res/values/strings.xml": `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="screen_title">${xmlText(spec.title)}</string>\n</resources>\n`,
    };
  }
  return {
    ...common,
    "project.godot": godotProject(spec),
    "scenes/main.tscn": MAIN_TSCN,
    "scripts/main.gd": MAIN_GD,
    "data/characters.json": charactersDocument(spec),
    "data/vfx.json": vfxDocument(spec),
    "data/levels.json": JSON.stringify({ levels: [{ id: "tutorial", boot: "menu" }] }, null, 2) + "\n",
    "data/models.json": modelsDocument(spec),
    "tools/blender_export.py": BLENDER_EXPORT_PY,
    ".gitignore": ".godot/\nbuild/\n",
  };
}

export function existingProjectDir(projectsRoot: string, slug: string): string {
  if (!SLUG.test(slug)) throw new UserError("프로젝트 이름을 확인하세요.");
  const root = realpathSync(projectsRoot);
  const real = realpathSync(path.join(root, slug));
  if (path.dirname(real) !== root || !statSync(real).isDirectory()) throw new UserError("프로젝트 위치가 올바르지 않습니다.");
  return real;
}

export function createProjectDir(projectsRoot: string, slug: string): string {
  if (!SLUG.test(slug)) throw new UserError("프로젝트 이름을 확인하세요.");
  const root = realpathSync(projectsRoot);
  if (!statSync(root).isDirectory()) throw new UserError("프로젝트 폴더를 확인하세요.");
  const destination = path.join(root, slug);
  if (existsSync(destination)) throw new UserError("이미 있는 프로젝트입니다.");
  mkdirSync(destination);
  const real = realpathSync(destination);
  if (path.dirname(real) !== root) throw new UserError("프로젝트 위치가 올바르지 않습니다.");
  return real;
}

export function writeTemplate(projectDir: string, spec: FactorySpec, template: boolean, provider: string, model: string): string[] {
  const written: string[] = [];
  for (const [relative, body] of Object.entries(filesFor(spec, template, provider, model))) {
    const safe = assertProjectRelative(relative);
    const absolute = path.join(projectDir, safe);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
    written.push(safe);
  }
  const git = spawnSync("git", ["init"], { cwd: projectDir, shell: false, windowsHide: true, encoding: "utf8" });
  if (git.status === 0) spawnSync("git", ["checkout", "-b", `factory/${spec.slug}`], { cwd: projectDir, shell: false, windowsHide: true, encoding: "utf8" });
  return written;
}
