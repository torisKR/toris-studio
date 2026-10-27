import { memo, useLayoutEffect, useRef, useState } from "react";
import type { AgentRole } from "./agent-client";
import type { Desk, DeskActivity, Handoff } from "./agent-office";
import { DESKS, DESK_SIZE, DESK_SPOTS, ROLE_LOOK, SCENE, TRAY, pixelPaths, walkPlan, type WalkPlan } from "./pixel-office";
import { LOOKS, PALETTE, type LookId } from "./pixel-sprites";

const BUBBLES: Partial<Record<DeskActivity, string[]>> = {
  thinking: [".....", ".....", "K.K.K", ".....", "....."],
  reading: ["KKKK.", "K..KK", "KKKKK", "K...K", "KKKKK"],
  coding: ["KK...", "..KKK", "KKK..", "..KK.", "KKKK."],
  testing: [".K.K.", "KKKKK", ".K.K.", "KKKKK", ".K.K."],
  reviewing: [".KK..", "K..K.", "K..K.", ".KKK.", "...KK"],
  approval: ["..A..", "..A..", "..A..", ".....", "..A.."],
  done: [".....", "....G", "...G.", "G.G..", ".G..."],
};
const BUBBLE_COLORS = { K: "#1b222c", A: "#b9822f", G: "#2f8a5f" };
const SCREEN: Partial<Record<DeskActivity, string>> = { thinking: "#5d86d6", reading: "#5d86d6", coding: "#92b8ff", testing: "#92b8ff", reviewing: "#5d86d6", approval: "#e6be83", done: "#8ae3bb" };
const LABEL: Record<AgentRole, string> = { supervisor: "PM", frontend: "FE", backend: "BE", qa: "QA" };

/** A pixel image; paths are computed once per frame. */
const Sprite = memo(function Sprite({ rows, colors }: { rows: string[]; colors: Record<string, string> }) {
  return <>{pixelPaths(rows, colors).map(p => <path key={p.fill} d={p.d} fill={p.fill} />)}</>;
});

function Person({ look, walking = false }: { look: LookId; walking?: boolean }) {
  const l = LOOKS[look];
  const colors = { ...PALETTE, ...l.colors };
  if (!walking) return <Sprite rows={l.stand} colors={colors} />;
  return <><g className="f-stand"><Sprite rows={l.stand} colors={colors} /></g><g className="f-stride"><Sprite rows={l.stride} colors={colors} /></g></>;
}

/** Head and shoulders of a role's person, for the desk cards. */
export function PixelPortrait({ role }: { role: AgentRole }) {
  const l = LOOKS[ROLE_LOOK[role]];
  return <svg className="pixel-portrait" viewBox="0 0 12 10" width="36" height="30" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
    <Sprite rows={l.stand.slice(0, 10)} colors={{ ...PALETTE, ...l.colors }} />
  </svg>;
}

function Room() {
  return <g className="pixel-room">
    <defs>
      <pattern id="pixel-floor" width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill="#101822" /><rect width="4" height="4" fill="#131d29" /><rect x="4" y="4" width="4" height="4" fill="#131d29" />
      </pattern>
    </defs>
    <rect width={SCENE.width} height={SCENE.height} fill="url(#pixel-floor)" />
    <rect width={SCENE.width} height="26" fill="#18212e" />
    <rect y="26" width={SCENE.width} height="2" fill="#2c3747" />
    {/* night windows with a few lit offices across the street */}
    {[24, 50, 124, 150].map(x => <g key={x}>
      <rect x={x} y="5" width="22" height="15" fill="#2c3747" /><rect x={x + 1} y="6" width="20" height="13" fill="#0b1017" />
      <rect x={x + 3} y="13" width="4" height="6" fill="#1a2433" /><rect x={x + 9} y="10" width="5" height="9" fill="#1a2433" /><rect x={x + 15} y="12" width="4" height="7" fill="#1a2433" />
      <rect x={x + 10} y="12" width="1" height="1" fill="#e6be83" /><rect x={x + 4} y="15" width="1" height="1" fill="#92b8ff" /><rect x={x + 16} y="14" width="1" height="1" fill="#e6be83" />
      <rect x={x + 10} y="6" width="1" height="13" fill="#2c3747" />
    </g>)}
    {/* whiteboard behind the PM */}
    <rect x="88" y="4" width="26" height="17" fill="#c9d3df" /><rect x="89" y="5" width="24" height="15" fill="#e8eef5" />
    <rect x="91" y="8" width="10" height="1" fill="#5d86d6" /><rect x="91" y="11" width="15" height="1" fill="#a4b2c4" /><rect x="91" y="14" width="8" height="1" fill="#a4b2c4" /><rect x="103" y="14" width="6" height="3" fill="#8ae3bb" />
    {/* door, plant, clock */}
    <rect x="4" y="8" width="14" height="20" fill="#2a3442" /><rect x="5" y="9" width="12" height="19" fill="#3b4757" /><rect x="14" y="18" width="2" height="2" fill="#e6be83" />
    <rect x="188" y="16" width="8" height="10" fill="#2f6b46" /><rect x="186" y="20" width="12" height="4" fill="#3f8a5a" /><rect x="189" y="26" width="6" height="5" fill="#7a5a43" />
    <rect x="73" y="7" width="7" height="7" fill="#e8eef5" /><rect x="76" y="8" width="1" height="3" fill="#1b222c" /><rect x="76" y="10" width="2" height="1" fill="#1b222c" />
  </g>;
}

function Tray({ waiting, final }: { waiting: boolean; final: boolean }) {
  const { x, y, width, height } = TRAY;
  return <g className="pixel-tray" data-state={waiting ? "waiting" : final ? "final" : "empty"}>
    <rect x={x} y={y} width={width} height={height} fill="#3b4757" /><rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} fill="#4a5869" />
    <rect x={x + 2} y={y + 9} width={width - 4} height="1" fill="#2c3747" /><rect x={x + 2} y={y + 17} width={width - 4} height="1" fill="#2c3747" />
    <rect x={x + 7} y={y + 12} width="4" height="1" fill="#a4b2c4" /><rect x={x + 7} y={y + 20} width="4" height="1" fill="#a4b2c4" />
    {/* "IN" plate */}
    <rect x={x + 4} y={y + 2} width="10" height="6" fill="#0e151e" />
    <rect x={x + 6} y={y + 3} width="1" height="4" fill="#92b8ff" />
    <rect x={x + 8} y={y + 3} width="1" height="4" fill="#92b8ff" /><rect x={x + 9} y={y + 4} width="1" height="1" fill="#92b8ff" /><rect x={x + 10} y={y + 5} width="1" height="1" fill="#92b8ff" /><rect x={x + 11} y={y + 3} width="1" height="4" fill="#92b8ff" />
    {(waiting || final) && <g className="pixel-tray-paper"><rect x={x + 3} y={y - 3} width="8" height="3" fill={waiting ? "#e6be83" : "#8ae3bb"} /><rect x={x + 6} y={y - 4} width="8" height="3" fill="#e8eef5" /></g>}
  </g>;
}

function DeskSet({ desk, away, pulse }: { desk: Desk; away: boolean; pulse: number }) {
  const at = DESKS[desk.id], seat = DESK_SPOTS[desk.id].seat;
  const screen = SCREEN[desk.activity] ?? "#1a2433";
  const bubble = BUBBLES[desk.activity];
  const present = desk.activity !== "away";
  return <g data-desk={desk.id} data-activity={desk.activity}>
    <rect x={seat.x - 1} y={seat.y + 4} width="14" height="12" fill="#2a3442" />{/* chair back */}
    <g data-character={desk.id} data-look={ROLE_LOOK[desk.id]} className={`pixel-person${!present ? " is-away" : away ? " is-walking" : ""}`} transform={`translate(${seat.x} ${seat.y})`}>
      <Person look={ROLE_LOOK[desk.id]} />
    </g>
    {/* desk front, monitor and papers; drawn after the person so it hides the legs */}
    <rect x={at.x} y={at.y} width={DESK_SIZE.width} height="3" fill="#8a6a4f" /><rect x={at.x} y={at.y + 3} width={DESK_SIZE.width} height={DESK_SIZE.height - 3} fill="#6b4f3a" />
    <rect x={at.x + 2} y={at.y + 5} width={DESK_SIZE.width - 4} height="1" fill="#5a412f" />
    <rect x={at.x + 25} y={at.y - 11} width="13" height="10" fill="#2c3747" /><rect key={`screen-${pulse}`} className="pixel-screen" x={at.x + 26} y={at.y - 10} width="11" height="8" fill={screen} />
    <rect x={at.x + 30} y={at.y - 1} width="3" height="1" fill="#2c3747" />
    <rect x={at.x + 2} y={at.y - 2} width="8" height="2" fill="#e8eef5" /><rect x={at.x + 3} y={at.y - 3} width="8" height="1" fill="#c9d3df" />
    {desk.activity === "approval" && <rect x={at.x + 12} y={at.y - 2} width="6" height="2" fill="#e6be83" />}
    <text x={at.x + DESK_SIZE.width / 2} y={at.y + 11} className="pixel-plate" textAnchor="middle">{LABEL[desk.id]}</text>
    {bubble && present && !away && <g transform={`translate(${seat.x + 8} ${seat.y - 10})`}><g key={`bubble-${pulse}`} className="pixel-bubble pixel-bubble-anim">
      <rect width="9" height="9" fill="#e8eef5" /><rect x="1" y="9" width="2" height="2" fill="#e8eef5" />
      <g transform="translate(2 2)"><Sprite rows={bubble} colors={BUBBLE_COLORS} /></g>
    </g></g>}
  </g>;
}

type Walk = WalkPlan & { key: string; kind: Handoff["kind"] };
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One walk per new hand-off. The run's state on opening is shown, not replayed. */
function useWalk(latest: Handoff | undefined) {
  const [walk, setWalk] = useState<Walk | null>(null);
  const seen = useRef<string | null>(null);
  const key = latest ? `${latest.seq}-${latest.kind}-${latest.from}-${latest.to}` : null;
  useLayoutEffect(() => {
    if (!latest || !key || key === seen.current) return;
    const first = seen.current === null;
    seen.current = key;
    const plan = walkPlan(latest);
    if (first || !plan || reducedMotion()) return;
    setWalk({ ...plan, key, kind: latest.kind });
  }, [key, latest]);
  return { walk, done: () => setWalk(null) };
}

export function PixelOffice({ desks, pulses, latest, tray, final, label }: { desks: Desk[]; pulses: Map<AgentRole, number>; latest: Handoff | undefined; tray: boolean; final: boolean; label: string }) {
  const { walk, done } = useWalk(latest);
  // Back row first so nearer desks overlap it.
  const ordered = [...desks].sort((a, b) => DESKS[a.id].y - DESKS[b.id].y);
  return <svg className="pixel-office" role="img" aria-label={label} viewBox={`0 0 ${SCENE.width} ${SCENE.height}`} shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">
    <Room />
    <Tray waiting={tray} final={final} />
    {ordered.map(desk => <DeskSet key={desk.id} desk={desk} away={walk?.walker === desk.id} pulse={pulses.get(desk.id) ?? 0} />)}
    {walk && <g key={walk.key} className="pixel-walker" data-kind={walk.kind} data-walker={walk.walker}
      style={{ "--fx": `${walk.from.x}px`, "--fy": `${walk.from.y}px`, "--tx": `${walk.to.x}px`, "--ty": `${walk.to.y}px` } as React.CSSProperties}
      onAnimationEnd={e => { if (e.animationName === "pixel-walk") done(); }}>
      <Person look={ROLE_LOOK[walk.walker]} walking />
      <g className="pixel-carried"><rect x="9" y="9" width="5" height="6" fill={walk.kind === "sendBack" || walk.kind === "approval" ? "#e6be83" : walk.kind === "final" ? "#8ae3bb" : "#e8eef5"} /><rect x="10" y="11" width="3" height="1" fill="#2c3747" /></g>
    </g>}
  </svg>;
}
