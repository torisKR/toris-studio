import type { AgentRole } from "./agent-client";
import type { DeskActivity } from "./agent-office";

/** What each role's monitor shows: UI layout blocks, code brackets, or text lines. */
function Screen({ role }: { role: AgentRole }) {
  if (role === "frontend") return <g className="w-screen-art"><rect x="47" y="23" width="7" height="5" rx="1" className="w-fill-accent" /><rect x="56" y="23" width="7" height="5" rx="1" /><rect x="47" y="30" width="16" height="2" rx="1" className="w-line-grow" /></g>;
  if (role === "backend") return <g className="w-screen-art w-stroke"><path d="M50 24l-3 4 3 4M59 24l3 4-3 4" fill="none" /><path d="M56 23.5l-3 9" fill="none" className="w-line-grow" /></g>;
  return <g className="w-screen-art"><rect x="47" y="23" width="9" height="1.6" rx=".8" /><rect x="47" y="27" width="14" height="1.6" rx=".8" className="w-line-grow" /><rect x="47" y="31" width="6" height="1.6" rx=".8" /></g>;
}

/** Worn by the person: PM headset and tie, QA magnifier. */
function Gear({ role }: { role: AgentRole }) {
  if (role === "supervisor") return <g className="w-gear"><path d="M19 17a7 7 0 0 1 14 0M33 17v3l3 1" fill="none" /><path d="M26 27l-1.5 5 1.5 2 1.5-2z" className="w-fill-accent" /></g>;
  if (role === "qa") return <g className="w-gear w-lens"><circle cx="41" cy="36" r="4" fill="none" /><path d="M44 39l3 3" fill="none" /></g>;
  return null;
}

/** A desk worker. The pose follows the agent's activity; motion plays a few times per new event, then stops. */
export function OfficeWorker({ role, activity }: { role: AgentRole; activity: DeskActivity }) {
  const present = activity !== "away";
  return <svg className="office-worker" data-role={role} data-activity={activity} viewBox="0 0 72 60" width="108" height="90" aria-hidden="true" focusable="false">
    <rect x="4" y="44" width="64" height="4" rx="1.5" className="w-desk" />
    <rect x="44" y="20" width="22" height="16" rx="2" className="w-screen" />
    <rect x="53" y="36" width="4" height="8" className="w-desk" />
    {activity === "done" ? <path d="M50 28l3 3 6-6" className="w-check" fill="none" /> : <Screen role={role} />}
    <g className="w-stack"><rect x="8" y="39" width="12" height="2" rx=".5" /><rect x="9" y="36.5" width="12" height="2" rx=".5" /><rect x="8" y="34" width="12" height="2" rx=".5" /></g>
    <rect x="18" y="30" width="14" height="16" rx="3" className="w-chair" />
    {present && <g className="w-person">
      <g className="w-head"><circle cx="26" cy="18" r="6.5" className="w-skin" /><path d="M19.6 16.5a6.5 6.5 0 0 1 12.8 0z" className="w-hair" /></g>
      <path d="M17 44v-9a9 9 0 0 1 18 0v9z" className="w-body" />
      <path d="M33 33l6 8" className="w-arm w-arm-r" fill="none" />
      <path d="M19 33l-2 8" className="w-arm w-arm-l" fill="none" />
      {(activity === "reading" || activity === "approval") && <g className="w-held"><rect x="36" y="22" width="9" height="12" rx="1" className="w-sheet" /><path d="M38 26h5M38 29h4" fill="none" /></g>}
      {activity === "thinking" && <g className="w-think"><circle cx="36" cy="10" r="1.2" /><circle cx="40" cy="7" r="1.6" /><circle cx="45" cy="4" r="2" /></g>}
      <Gear role={role} />
    </g>}
  </svg>;
}
