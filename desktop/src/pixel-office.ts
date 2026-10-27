// Pixel office: scene size, where each desk and seat is, and who walks where on a hand-off.
import type { AgentRole } from "./agent-client";
import type { Handoff } from "./agent-office";
import type { LookId } from "./pixel-sprites";

/** Scene size in pixels; the SVG scales it up with crisp edges. */
export const SCENE = { width: 200, height: 124 };
export type Point = { x: number; y: number };

export const ROLE_LOOK: Record<AgentRole, LookId> = { supervisor: "man30s", qa: "woman30s", frontend: "youngWoman", backend: "youngMan" };

/** Desk top-left corner, the seat behind it, and where a visitor stands in front of it. */
export const DESKS: Record<AgentRole, Point> = {
  supervisor: { x: 82, y: 40 },
  frontend: { x: 18, y: 86 },
  backend: { x: 80, y: 86 },
  qa: { x: 142, y: 86 },
};
export const DESK_SIZE = { width: 40, height: 14 };
export const DESK_SPOTS: Record<AgentRole, { seat: Point; visit: Point }> = Object.fromEntries(
  (Object.entries(DESKS) as Array<[AgentRole, Point]>).map(([role, d]) => [role, { seat: { x: d.x + 14, y: d.y - 12 }, visit: { x: d.x + 14, y: d.y + DESK_SIZE.height + 2 } }]),
) as Record<AgentRole, { seat: Point; visit: Point }>;
/** The user's in-tray cabinet, and where someone stands to use it. */
export const TRAY = { x: 166, y: 30, width: 18, height: 24 };
export const TRAY_SPOT: Point = { x: 150, y: 46 };

export type WalkPlan = { walker: AgentRole; from: Point; to: Point };

/** The agent side of a hand-off walks to the other side's spot. The user never walks. */
export function walkPlan(handoff: Handoff): WalkPlan | null {
  const walker = handoff.from === "user" ? handoff.to : handoff.from;
  const other = handoff.from === "user" ? handoff.from : handoff.to;
  if (walker === "user") return null;
  return { walker, from: DESK_SPOTS[walker].seat, to: other === "user" ? TRAY_SPOT : DESK_SPOTS[other].visit };
}

/** One SVG path per color; runs of the same color on a row become one rectangle. */
export function pixelPaths(rows: string[], colors: Record<string, string>): Array<{ fill: string; d: string }> {
  const byColor = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const fill = colors[ch];
      if (ch !== "." && fill) byColor.set(fill, `${byColor.get(fill) ?? ""}M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return [...byColor].map(([fill, d]) => ({ fill, d }));
}
