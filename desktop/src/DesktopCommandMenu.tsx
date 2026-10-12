import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { commandShortcut, filterCommands, moveCommandSelection } from "./desktop-interactions";
import "./DesktopCommandMenu.css";

type Command<T extends string> = { id: T; label: string; group: string };

export function DesktopCommandMenu<T extends string>({ items, onNavigate }: { items: readonly Command<T>[]; onNavigate: (id: T) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = filterCommands(items, query);
  const selectedIndex = Math.min(selected, Math.max(0, matches.length - 1));

  function open() {
    // Preserve another modal's focus and unsaved form rather than stacking dialogs.
    if (document.querySelector("dialog[open]")) return;
    setQuery(""); setSelected(0);
    dialog.current?.showModal();
    field.current?.focus();
  }
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (commandShortcut(event) === "open") { event.preventDefault(); opener.current(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(`[data-command-index="${selectedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query]);

  function select(item: Command<T>) { dialog.current?.close(); onNavigate(item.id); }
  return <>
    <button ref={trigger} type="button" className="desktop-command-trigger" onClick={open} aria-haspopup="dialog" aria-label="메뉴 검색 · Ctrl 또는 Command K"><Search size={15} aria-hidden="true" /><span>메뉴 검색</span><kbd>⌘ / Ctrl K</kbd></button>
    <dialog ref={dialog} className="desktop-command-dialog" aria-labelledby="desktop-command-title" onClose={() => trigger.current?.focus()} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="desktop-command-heading"><h2 id="desktop-command-title">어디로 이동할까요?</h2><button type="button" aria-label="메뉴 검색 닫기" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <label className="desktop-command-search"><Search size={18} aria-hidden="true" /><input ref={field} aria-label="화면 이름 검색" placeholder="영상, 키워드, 연결 설정…" value={query} maxLength={80} autoComplete="off" onChange={event => { setQuery(event.target.value); setSelected(0); }} role="combobox" aria-expanded={true} aria-controls="desktop-command-results" aria-autocomplete="list" aria-activedescendant={matches[selectedIndex] ? `desktop-command-${matches[selectedIndex].id}` : undefined} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(moveCommandSelection(selectedIndex, event.key === "ArrowDown" ? 1 : -1, matches.length)); }
        else if (event.key === "Enter") { event.preventDefault(); if (matches[selectedIndex]) select(matches[selectedIndex]); }
      }} /></label>
      <div id="desktop-command-results" className="desktop-command-results" role="listbox" aria-label="이동할 화면">{matches.map((item, index) => <button key={item.id} id={`desktop-command-${item.id}`} data-command-index={index} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} onPointerMove={() => setSelected(index)} onClick={() => select(item)}><span>{item.label}</span><small>{item.group}</small></button>)}</div>
      {!matches.length && <p className="desktop-command-empty" role="status">일치하는 메뉴가 없습니다.</p>}
      <p className="desktop-command-hint">↑ ↓ 선택 · Enter 이동 · Esc 닫기</p>
    </dialog>
  </>;
}
