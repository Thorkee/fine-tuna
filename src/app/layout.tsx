import type { Metadata, Viewport } from "next";
import { Nunito_Sans } from "next/font/google";
import "./globals.css";

const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-nunito-sans",
});

const themeInitScript = `
(() => {
  try {
    var key = "tuna.theme";
    var pref = null;
    try {
      pref = window.localStorage.getItem(key);
    } catch (e) {}
    if (!pref) {
      try {
        var part = document.cookie
          .split("; ")
          .find(function (p) {
            return p.indexOf(key + "=") === 0;
          });
        if (part) pref = part.split("=")[1];
      } catch (e) {}
    }
    if (pref !== "dark" && pref !== "light" && pref !== "system") pref = null;

    var resolveSystem = function () {
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
          return "dark";
        }
      } catch (e) {}
      return "light";
    };

    var apply = function (theme) {
      document.documentElement.setAttribute("data-theme", theme);
    };

    var theme = pref === "dark" || pref === "light" ? pref : pref === "system" ? resolveSystem() : "light";
    apply(theme);

    // Keep the resolved theme synced to OS changes when in "system" mode.
    if (pref === "system") {
      try {
        var mql = window.matchMedia("(prefers-color-scheme: dark)");
        var onChange = function (e) {
          apply(e && e.matches ? "dark" : "light");
        };
        if (mql && typeof mql.addEventListener === "function") {
          mql.addEventListener("change", onChange);
        } else if (mql && typeof mql.addListener === "function") {
          mql.addListener(onChange);
        }
      } catch (e) {}
    }
  } catch (e) {}
})();
`;

const sidebarInitScript = `
(() => {
  try {
    var key = "tuna.sidebar.collapsed";
    var stored = null;
    try {
      stored = window.localStorage.getItem(key);
    } catch (e) {}
    if (stored == null) {
      try {
        var part = document.cookie
          .split("; ")
          .find(function (p) {
            return p.indexOf(key + "=") === 0;
          });
        if (part) stored = decodeURIComponent(part.split("=")[1] || "");
      } catch (e) {}
    }
    var isCollapsed = stored === "1" || stored === "true";
    var root = document.documentElement;
    root.setAttribute("data-sidebar-collapsed", isCollapsed ? "1" : "0");
    root.style.setProperty("--sidebar-width", isCollapsed ? "72px" : "280px");
  } catch (e) {}
})();
`;

export const metadata: Metadata = {
  title: "Tuna Agent",
  description: "Natural-language AI training and deployment orchestration",
  keywords: ["AI", "ML", "machine learning", "training", "compute", "GPU"],
  icons: {
    icon: "/tuna.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: sidebarInitScript }} />
      </head>
      <body className={`${nunitoSans.variable} font-sans antialiased min-h-dvh`}>
        {children}
      </body>
    </html>
  );
}
