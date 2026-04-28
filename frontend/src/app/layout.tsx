import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Manrope } from "next/font/google";

import { designSystemCssVariables } from "@/styles/designSystem";

import "./globals.css";
import "@/components/workspace/workspace.css";

const body = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "THE SPHERE",
  description: "Global Event Impact Engine — live intelligence, impact reasoning, and executive briefings.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${body.variable} ${mono.variable}`} style={designSystemCssVariables}>
        {children}
      </body>
    </html>
  );
}
