import type { Metadata } from "next";
import { SocialDashboard } from "@/components/SocialDashboard";
import "./manage.css";

export const metadata: Metadata = {
  title: "콘텐츠 워크스페이스 · Toris Studio",
  description: "로컬 DB에서 채널, 콘텐츠 계획, 최신 키워드와 AI 초안을 관리하세요."
};

export default function ManagePage() {
  return <SocialDashboard />;
}
