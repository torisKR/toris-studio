import React from "react";
import ReactDOM from "react-dom/client";
import { NativeRenderPreview } from "./NativeRenderPreview";
import { StartupErrorBoundary } from "./StartupErrorBoundary";
import { getRenderPreviewInfo } from "./native-windows";
import "./style.css";

const App = React.lazy(() => import("./App").then(module => ({ default: module.App })));
const preview = getRenderPreviewInfo();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><StartupErrorBoundary>{preview ? <NativeRenderPreview initial={preview} /> :
    <React.Suspense fallback={<div role="status">Toris Studio를 열고 있습니다.</div>}><App /></React.Suspense>
  }</StartupErrorBoundary></React.StrictMode>
);
