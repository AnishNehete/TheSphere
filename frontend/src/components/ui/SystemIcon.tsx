"use client";

import type { SVGProps } from "react";

type IconName = "globe" | "flights" | "weather" | "conflict" | "health" | "search" | "spark" | "close";

interface SystemIconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

const ICONS: Record<IconName, string> = {
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zm0 0c2.6 2.5 4 5.5 4 9s-1.4 6.5-4 9m0-18c-2.6 2.5-4 5.5-4 9s1.4 6.5 4 9m-8.5-6h17M3.5 9h17",
  flights: "M4 14l16-4l-16-4l2.5 4L4 14zm0 0l4 2",
  weather: "M7 18h8m-6-3h7a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.2 8.4A3.2 3.2 0 0 0 9 15z",
  conflict: "M12 3l8 15H4L12 3zm0 5v4m0 3h.01",
  health: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 1 0-14a7 7 0 0 1 0 14zm5-1l4 4",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zm6.5 12.5l.8 2.2l2.2.8l-2.2.8l-.8 2.2l-.8-2.2l-2.2-.8l2.2-.8l.8-2.2z",
  close: "M6 6l12 12M18 6L6 18",
};

export function SystemIcon({ name, ...props }: SystemIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
