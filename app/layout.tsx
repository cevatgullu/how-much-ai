import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible_Mono,
  Atkinson_Hyperlegible_Next,
  Barlow_Condensed,
} from "next/font/google";
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

export const metadata: Metadata = {
  title: "How Much AI",
  description: "Claude ve ChatGPT/Codex kullanım limitleri için yerel kota cetveli.",
  applicationName: "How Much AI",
  // A self-hosted credential dashboard should never be indexed accidentally.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#111614",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className={`${headingFont.variable} ${bodyFont.variable} ${dataFont.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
