import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import PwaProvider from "@/components/PwaProvider";
import "./globals.css";

/** iOS ignores the web manifest, so launch images are declared by media query. */
const IOS_SPLASH = [
  { w: 1290, h: 2796, dppx: 3 }, // 15/16 Pro Max
  { w: 1179, h: 2556, dppx: 3 }, // 15/16 Pro
  { w: 1284, h: 2778, dppx: 3 }, // 12/13/14 Pro Max
  { w: 1170, h: 2532, dppx: 3 }, // 12/13/14
  { w: 1242, h: 2688, dppx: 3 }, // XS Max / 11 Pro Max
  { w: 1125, h: 2436, dppx: 3 }, // X / XS / 11 Pro
  { w: 828, h: 1792, dppx: 2 }, // XR / 11
  { w: 750, h: 1334, dppx: 2 }, // SE / 8
];

export const metadata: Metadata = {
  title: "SKELLZ Neon — 3D street cap battle",
  description:
    "The NYC milk-top street game Skellzs, reborn in 3D. Play online with up to 8 players, or take on the CPU across 20 boroughs.",
  applicationName: "SKELLZ",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "64x64", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "SKELLZ",
    // Lets the board run under the status bar; the HUD keeps clear of it using
    // the safe-area insets.
    statusBarStyle: "black-translucent",
    startupImage: IOS_SPLASH.map(({ w, h, dppx }) => ({
      url: `/splash/${w}x${h}.png`,
      media: `(device-width: ${w / dppx}px) and (device-height: ${h / dppx}px) and (-webkit-device-pixel-ratio: ${dppx}) and (orientation: portrait)`,
    })),
  },
  formatDetection: { telephone: false, date: false, address: false, email: false },
  other: {
    // Next emits only the standardised `mobile-web-app-capable`. iOS Safari
    // still reads the legacy apple-prefixed tag to decide whether a home
    // screen launch opens standalone or inside a normal Safari view, so it has
    // to be declared by hand.
    "apple-mobile-web-app-capable": "yes",
  },
  openGraph: {
    title: "SKELLZ Neon — 3D street cap battle",
    description: "The NYC milk-top street game, reborn in 3D. Up to 8 players online.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#05070d",
  width: "device-width",
  initialScale: 1,
  // The board does its own pinch-to-zoom and two-finger spin — browser zoom
  // would fight it. `cover` lets the scene fill the notch area, and the HUD
  // is inset with env(safe-area-inset-*) so nothing lands under the cutout.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#05070d] text-white antialiased overscroll-none">
        <PwaProvider />
        {children}
      </body>
    </html>
  );
}
