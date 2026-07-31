import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SKELLZ Neon — 3D street cap battle",
    short_name: "SKELLZ",
    description:
      "The NYC milk-top street game, in 3D. Break from START, run 1 to 13 and back, then become a KILLA. Up to 8 players online, or take on the CPU.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Android hides the status bar entirely in fullscreen, which suits a
    // board that already uses every pixel. Falls back to standalone elsewhere.
    display_override: ["fullscreen", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#05070d",
    theme_color: "#05070d",
    categories: ["games", "entertainment"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Public PvP room",
        short_name: "PvP",
        url: "/play/PVPX",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Public story room",
        short_name: "Story",
        url: "/play/STRY",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
