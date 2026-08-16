import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible_Mono,
  Atkinson_Hyperlegible_Next,
  Barlow_Condensed,
} from "next/font/google";
import { appMetadata, appViewport } from "@/lib/pwa-shell";
import "./globals.css";

const headingFont = Barlow_Condensed({
  subsets: ["latin-ext"],
  weight: ["500", "600", "700"],
  display: "swap",
  variable: "--font-heading",
});
const bodyFont = Atkinson_Hyperlegible_Next({
  subsets: ["latin-ext"],
  display: "swap",
  variable: "--font-body",
});
const dataFont = Atkinson_Hyperlegible_Mono({
  subsets: ["latin-ext"],
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
