// Web App Manifest — the one thing missing for an installable mobile shell.
//
// iOS only delivers Web Push to a site the user has added to the Home Screen, and it only
// offers that install when a manifest declares a standalone display mode. The manifest is
// therefore a prerequisite for the phone experience, not decoration.
//
// It is served in every topology. In strict-local mode nothing consumes it — the local build
// has no push subscription path and the launcher opens a dedicated window directly — but a
// static metadata document leaks nothing and keeps the two builds from diverging.

import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "How Much AI",
    short_name: "How Much AI",
    description: "Claude, ChatGPT/Codex ve Grok kullanım limitleri için kota cetveli.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0d14",
    theme_color: "#0b0d14",
    lang: "tr",
    dir: "ltr",
    orientation: "any",
    icons: [
      { src: "/pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // A separate maskable asset with its own safe area: reusing an `any` icon here gets the
      // artwork cropped by the platform mask on Android.
      { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
