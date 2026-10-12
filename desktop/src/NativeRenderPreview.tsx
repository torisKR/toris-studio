import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getRenderPreviewInfo, type RenderPreviewInfo } from "./native-windows";
import "./NativeRenderPreview.css";

export function NativeRenderPreview({ initial }: { initial: RenderPreviewInfo }) {
  const [preview, setPreview] = useState(initial);
  const [status, setStatus] = useState("영상을 준비하고 있습니다.");
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const update = () => {
      const value = getRenderPreviewInfo();
      if (value) setPreview(previous => previous.key === value.key ? previous : value);
    };
    window.addEventListener("toris-native-preview-change", update);
    update();
    return () => window.removeEventListener("toris-native-preview-change", update);
  }, []);
  useEffect(() => {
    const player = video.current;
    if (!player) return;
    setStatus("영상을 준비하고 있습니다.");
    player.src = convertFileSrc(preview.key, "toris-preview");
    player.load();
    const stop = () => { player.pause(); player.removeAttribute("src"); player.load(); };
    window.addEventListener("beforeunload", stop);
    return () => { window.removeEventListener("beforeunload", stop); stop(); };
  }, [preview.key]);
  return <main className="native-render-preview">
    <header><div><span>영상 미리보기</span><h1>{preview.title}</h1></div><small>{(preview.fileSize / 1024 ** 2).toFixed(1)} MiB</small></header>
    <section aria-label="출력한 MP4 재생">
      <video ref={video} controls playsInline preload="metadata" onLoadedMetadata={() => setStatus("")} onError={() => setStatus("영상을 불러오지 못했습니다. 기본 화면에서 미리보기를 다시 여세요.")} />
      {status && <p role="status">{status}</p>}
    </section>
    <footer>기본 화면에서 다른 영상을 선택하면 이 창의 미리보기가 바뀝니다.</footer>
  </main>;
}
