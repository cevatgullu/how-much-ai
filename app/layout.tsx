import type { Metadata, Viewport } from "next";
import {
  Figtree,
  IBM_Plex_Mono,
  Oswald,
} from "next/font/google";
import { appMetadata, appViewport } from "@/lib/pwa-shell";
import "./globals.css";

const headingFont = Oswald({
  subsets: ["latin-ext"],
  weight: ["500", "600", "700"],
  display: "swap",
  variable: "--font-heading",
});
const bodyFont = Figtree({
  subsets: ["latin-ext"],
  display: "swap",
  variable: "--font-body",
});
const dataFont = IBM_Plex_Mono({
  subsets: ["latin-ext"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-data",
});

// Declared in lib/pwa-shell so the installed-shell contract can be tested without loading the
// font modules this file pulls in.
export const metadata: Metadata = appMetadata;
export const viewport: Viewport = appViewport;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className={`${headingFont.variable} ${bodyFont.variable} ${dataFont.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
