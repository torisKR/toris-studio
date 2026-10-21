import React from "react";

export class StartupErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, color: "#edf2f7" }}>
      <section role="alert" aria-labelledby="startup-error-title" style={{ maxWidth: 520, lineHeight: 1.7 }}>
        <h1 id="startup-error-title" style={{ fontSize: 24 }}>Toris Studio 화면을 열지 못했습니다.</h1>
        <p>앱을 다시 불러와 주세요. 저장된 프로젝트와 연결 설정은 유지됩니다.</p>
        <p>저장하지 않은 편집은 다시 확인해 주세요. 문제가 계속되면 앱을 종료한 뒤 다시 실행해 주세요.</p>
        <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: "10px 20px", border: "1px solid #92b8ff", borderRadius: 8, background: "#92b8ff", color: "#0b1017", cursor: "pointer" }}>다시 불러오기</button>
      </section>
    </main>;
  }
}
