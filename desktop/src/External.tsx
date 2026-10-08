import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { url?: string };

/** The Rust command validates the URL and opens the system browser. */
export function External({ url, className = "", children, ...props }: Props) {
  const [error, setError] = useState("");
  return <span className="social-external-wrap">
    <button type="button" className={`social-external ${className}`} {...props} disabled={!url || props.disabled}
      onClick={() => {
        setError("");
        if (url) void invoke("open_external", { url }).catch((reason: unknown) => {
          setError(typeof reason === "string" ? reason : "링크를 열지 못했습니다.");
        });
      }}>{children}</button>
    {error && <small className="social-external-error" role="alert">{error}</small>}
  </span>;
}
