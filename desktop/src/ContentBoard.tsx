import { ChevronLeft, ChevronRight, MoveHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CONTENT_STATUSES } from "./types";
import type { ContentStatus, SocialContent } from "./types";
import "./ContentBoard.css";

const labels: Record<ContentStatus, string> = {
  draft: "초안", ready: "검토 완료", scheduled: "발행 계획", published: "발행 기록"
};
const emptyLabels: Record<ContentStatus, string> = {
  draft: "첫 아이디어를 적어보세요",
  ready: "검토를 마친 초안을 모아두세요",
  scheduled: "다음 발행 일정을 계획하세요",
  published: "발행한 콘텐츠를 기록하세요"
};

export interface ContentBoardProps {
  items: readonly SocialContent[];
  renderContentCard: (item: SocialContent) => ReactNode;
  onAddContent: (status: ContentStatus) => void;
  canAddContent: boolean;
  showCreateDraft?: boolean;
  renderEmpty?: (status: ContentStatus) => ReactNode;
}

function motionBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** Native scrolling keeps text selection, card buttons, and trackpad gestures available. */
export function ContentBoard({
  items, renderContentCard, onAddContent, canAddContent, showCreateDraft = true, renderEmpty
}: ContentBoardProps) {
  const board = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const keyboardId = useId();
  const [edges, setEdges] = useState({ left: false, right: false, overflow: false });

  const measure = useCallback(() => {
    const element = board.current;
    if (!element) return;
    const max = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = {
      left: element.scrollLeft > 1,
      right: element.scrollLeft < max - 1,
      overflow: max > 1
    };
    setEdges((current) => current.left === next.left && current.right === next.right
      && current.overflow === next.overflow ? current : next);
  }, []);

  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    // Lane widths change at breakpoints even when the outer board remains the same size.
    for (const lane of element.children) resize.observe(lane);
    measure();

    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const max = element.scrollWidth - element.clientWidth;
      if (max <= 1) return;
      // Browser-native horizontal trackpad gestures already follow the board's scroll chain.
      if (!event.shiftKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const target = event.target instanceof Element ? event.target : null;
      const laneBody = target?.closest<HTMLElement>(".content-board-lane-body");
      // An ordinary wheel over a long column scrolls that column vertically.
      if (!event.shiftKey && laneBody && laneBody.scrollHeight > laneBody.clientHeight + 1) return;
      const raw = event.shiftKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX : event.deltaY;
      const delta = raw * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 24
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1);
      if (!delta || (delta < 0 && element.scrollLeft <= 0)
        || (delta > 0 && element.scrollLeft >= max - 1)) return;
      event.preventDefault();
      element.scrollLeft = Math.max(0, Math.min(max, element.scrollLeft + delta));
    };
    // A non-passive native listener is necessary to translate mouse-wheel motion without
    // simultaneously scrolling the document. Nested columns retain their native vertical wheel.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      resize.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, [measure]);

  const move = (direction: -1 | 1) => {
    const element = board.current;
    if (!element) return;
    const first = element.firstElementChild as HTMLElement | null;
    const gap = Number.parseFloat(window.getComputedStyle(element).columnGap) || 13;
    element.scrollBy({ left: direction * ((first?.offsetWidth ?? element.clientWidth) + gap), behavior: motionBehavior() });
  };

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = board.current;
    if (!element || event.altKey || event.ctrlKey || event.metaKey) return;
    // Do not capture keys from card links, buttons, text fields, or any embedded editor.
    const target = event.target;
    if (target !== element && !(target instanceof HTMLElement && target.classList.contains("content-board-lane-body"))) return;
    const lane = target !== element ? target as HTMLElement : null;
    if (lane && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const amount = event.key === "ArrowUp" ? -80 : event.key === "ArrowDown" ? 80
        : event.key === "PageUp" ? -lane.clientHeight * .85 : lane.clientHeight * .85;
      if (event.key === "Home" || event.key === "End") lane.scrollTo({ top: event.key === "Home" ? 0 : lane.scrollHeight, behavior: motionBehavior() });
      else lane.scrollBy({ top: amount, behavior: motionBehavior() });
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home" || event.key === "End") {
      element.scrollTo({ left: event.key === "Home" ? 0 : element.scrollWidth, behavior: motionBehavior() });
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      element.scrollBy({ left: (event.key === "PageUp" ? -1 : 1) * element.clientWidth * .85, behavior: motionBehavior() });
    } else move(event.key === "ArrowLeft" ? -1 : 1);
  };

  return <section className="content-board" aria-label="콘텐츠 칸반">
    <div className="content-board-toolbar">
      <p id={hintId} className="content-board-hint"><MoveHorizontal size={15} aria-hidden="true" />
        <span>{edges.overflow ? "좌우 스크롤 · Shift + 휠로 상태 열 이동" : "상태별 콘텐츠를 한눈에 확인하세요"}<small>카드 목록은 위아래로 스크롤할 수 있어요.</small></span>
      </p>
      <div className="content-board-controls" role="group" aria-label="칸반 열 이동">
        <button type="button" aria-label="이전 상태 열 보기" disabled={!edges.left} onClick={() => move(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
        <button type="button" aria-label="다음 상태 열 보기" disabled={!edges.right} onClick={() => move(1)}><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
    <p id={keyboardId} className="social-sr-only">보드를 선택하면 왼쪽·오른쪽 방향키와 Page Up·Page Down으로 상태 열을 이동합니다. Home은 첫 열, End는 마지막 열입니다. 각 카드 목록을 선택하면 위·아래 방향키와 Page Up·Page Down으로 목록을 스크롤합니다.</p>
    <div ref={board} className="content-board-scroll" role="region" aria-label="콘텐츠 진행 상태" aria-describedby={`${hintId} ${keyboardId}`} tabIndex={0} onScroll={measure} onKeyDown={keyboard}>
      {CONTENT_STATUSES.map((status) => {
        const laneItems = items.filter((item) => item.status === status);
        return <section className={`social-lane content-board-lane ${status}`} key={status} aria-label={labels[status]}>
          <div className="social-lane-heading"><h2><span className="social-status-dot" aria-hidden="true" />{labels[status]}<small>{laneItems.length}</small></h2><button type="button" className="social-add" aria-label={`${labels[status]} 콘텐츠 추가`} disabled={!canAddContent} onClick={() => onAddContent(status)}><Plus size={17} aria-hidden="true" /></button></div>
          <div className="social-lane-body content-board-lane-body" role="region" aria-label={`${labels[status]} 카드 목록, ${laneItems.length}개`} tabIndex={0}>
            {laneItems.map((item) => <div className="content-board-card" key={item.id}>{renderContentCard(item)}</div>)}
            {laneItems.length === 0 && (renderEmpty ? renderEmpty(status) : <div className="social-lane-empty"><span>{emptyLabels[status]}</span>{status === "draft" && showCreateDraft && <button type="button" disabled={!canAddContent} onClick={() => onAddContent("draft")}><Plus size={14} aria-hidden="true" />초안 만들기</button>}</div>)}
          </div>
        </section>;
      })}
    </div>
  </section>;
}
