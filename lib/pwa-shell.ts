// Document metadata for the installed shell.
//
// This lives outside app/layout.tsx so it can be asserted directly: the layout module imports
// next/font/google, which a test process cannot load, and "iPhone home-screen install still works"
// is exactly the kind of claim that should not rest on reading the file as text.
//
// iOS is the constraint that shapes all of it. Safari only offers "Ana Ekrana Ekle" — and only
// delivers Web Push — to a site whose manifest declares a standalone display mode, and it reads the
// apple-mobile-web-app-* meta tags rather than the manifest for the installed window's chrome. So
// both are declared, and they agree.

import type { Metadata, Viewport } from "next";

export const APP_NAME = "How Much AI";
export const APP_DESCRIPTION = "Claude, ChatGPT/Codex ve Grok kullanım limitleri için kota cetveli.";

export const appMetadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  // A self-hosted credential dashboard should never be indexed accidentally.
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    // The home-screen label. Without it iOS uses the <title>, which is the same string today but
    // would silently drift the moment the page title gains a suffix.
    title: APP_NAME,
    // Draws the app under the status bar. Correct only because every edge of the shell already
    // pads by env(safe-area-inset-*); without that padding the header would sit under the clock.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon.svg",
    // iOS still prefers a raster touch icon for the home-screen tile.
    apple: [{ url: "/pwa-icon-192.png", sizes: "180x180", type: "image/png" }],
  },
};

export const appViewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Extends the canvas into the notch/dynamic-island area so the safe-area insets become non-zero
  // and the shell can decide for itself where its edges are.
  viewportFit: "cover",
  themeColor: "#0b0d14",
  // Deliberately no `maximumScale`/`userScalable: false`. Pinch-zoom is an accessibility
  // affordance, and locking it is not a legitimate way to stop rubber-banding — the scroll
  // containment in globals.css does that without taking zoom away.
};
