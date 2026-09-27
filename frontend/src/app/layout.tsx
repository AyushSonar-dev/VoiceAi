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
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREF_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
