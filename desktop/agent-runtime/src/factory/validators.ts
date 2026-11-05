// Quality gates look at files and process results. A missing tool is blocked,
// never recorded as a pass.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fingerprintMatches } from "./artifacts.js";

export type GateStatus = "passed" | "failed" | "blocked" | "not_run";
export type FactoryGate = { name: "plan" | "code" | "asset" | "model3d" | "gameplay" | "android" | "release"; status: GateStatus; detail: string; required: boolean };

export function pngAlphaProblem(bytes: Buffer): string | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 26 || signature.some((byte, index) => bytes[index] !== byte)) return "PNG 서명이 아닙니다.";
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return "IHDR이 없습니다.";
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const color = bytes[25];
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return "프레임 크기가 범위를 벗어납니다.";
  if (color !== 4 && color !== 6) return "알파 채널이 없습니다.";
  return null;
}

/** Every dangerous-permission name in a manifest. The factory template has none. */
export function unexpectedPermissions(xml: string): string[] {
  const found = [...xml.matchAll(/android:name="([^"]+)"/g)].map(match => match[1] ?? "");
  return found.filter(name => name.startsWith("android.permission."));
}

export function scriptUnsafe(source: string): string | null {
  if (/OS\.execute|OS\.shell_open|JavaScriptBridge|\beval\(/.test(source)) return "스크립트에 명령 실행이 있습니다.";
  return null;
}

export function verdictOf(gates: FactoryGate[]): "pass" | "incomplete" | "fail" {
  const required = gates.filter(gate => gate.required);
  if (!required.length) return "incomplete";
  if (required.some(gate => gate.status === "failed")) return "fail";
  if (required.every(gate => gate.status === "passed")) return "pass";
  return "incomplete";
}

export function fileHashOk(projectDir: string, relative: string, hashes: string[]): boolean {
  const prefix = relative + ":";
  const recorded = hashes.find(hash => hash.startsWith(prefix));
  if (!recorded) return false;
  return fingerprintMatches(projectDir, recorded);
}

export function readProjectText(projectDir: string, relative: string): string | null {
  try { return readFileSync(path.join(projectDir, relative), "utf8"); } catch { return null; }
}
