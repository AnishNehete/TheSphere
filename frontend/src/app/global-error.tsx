"use client";

import { GlassPanel } from "@/components/ui/GlassPanel";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body className="app-error">
        <GlassPanel className="app-error__panel">
          <h1>Runtime Error</h1>
          <p>The experience encountered an unrecoverable error.</p>
          <button type="button" onClick={reset}>
            Retry
          </button>
        </GlassPanel>
      </body>
    </html>
  );
}
