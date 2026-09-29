import type { Metadata, Viewport } from "next";
import type { PropsWithChildren } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echo — Voice Shopping Assistant",
  description: "A voice-first, screen-reader friendly shopping assistant.",
};

export const viewport: Viewport = {
  themeColor: "#08090b",
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
};

/**
 * Applied before first paint, from the same localStorage keys the settings UI
 * writes. Without this the page renders in the default palette and then snaps to
 * the saved one, which is disorienting for exactly the users who chose a high
 * contrast setting. Presentation only — nothing here is sent to the backend.
 *
 * It sets four things on the root element — `data-theme`,
 * `data-reduced-motion`, the inline `--content-scale` and the inline `font-size`
 * — and it must run before hydration, which is the whole point: a saved
 * preference has to be in effect for the very first painted frame. Those
 * attributes therefore exist in the DOM before React compares them against the
 * server-rendered `<html>`, which renders none of them. That difference is
 * intended, is confined to this one element, and is left to stand: see
 * `suppressHydrationWarning` below.
 *
 * Everything else in the preference system is hydration-safe already — `usePrefs`
 * reads localStorage in an effect after mount and writes the same attributes
 * from React, so this script and React converge on identical values.
 */
const PREF_BOOTSTRAP = `(function(){try{var r=document.documentElement;
var t=localStorage.getItem("echolabs.theme");
r.dataset.theme=(t==="light"||t==="dark")?t:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
var m=localStorage.getItem("echolabs.magnify");
var scale=(m==="125"||m==="150"||m==="200")?parseInt(m,10)/100:1;
r.style.setProperty("--content-scale",String(scale));
var f=localStorage.getItem("echolabs.fontSizePercent");
var fs=f?parseInt(f,10):NaN;
if(!isNaN(fs)&&fs>=85&&fs<=160){r.style.fontSize=fs+"%";}
var rm=localStorage.getItem("echolabs.reducedMotion");
var reduced=rm==="true"||(rm===null&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);
r.dataset.reducedMotion=reduced?"on":"off";}catch(e){}})();`;

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    /*
     * `suppressHydrationWarning` is scoped to this one element on purpose. The
     * attributes above are applied to `<html>` by a pre-hydration script, so the
     * client DOM legitimately holds values the server markup never had. React
     * cannot reconcile those — the saved preference is the correct value, and
     * overwriting it with the server's would undo the user's choice and cause the
     * flash of wrong contrast this script exists to prevent. Scoping it here
     * keeps every other hydration mismatch reported normally, rather than hiding
     * real bugs across the tree.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREF_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
