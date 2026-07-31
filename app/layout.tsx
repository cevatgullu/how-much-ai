import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "How Much AI",
  description: "A self-hosted dashboard for Claude and ChatGPT/Codex subscription usage limits.",
  applicationName: "How Much AI",
  // A self-hosted credential dashboard should never be indexed accidentally.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
