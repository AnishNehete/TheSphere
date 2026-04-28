"use client";

import { useEffect, useState } from "react";

export function useDelayedValue<T>(value: T, delayMs: number) {
  const [delayedValue, setDelayedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDelayedValue(value);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return delayedValue;
}

