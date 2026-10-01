import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Toris Studio",
  description: "Local-first programmatic video studio"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
