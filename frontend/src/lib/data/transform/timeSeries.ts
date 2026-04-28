export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export function appendPoint(
  points: TimeSeriesPoint[],
  point: TimeSeriesPoint,
  maxPoints = 120
): TimeSeriesPoint[] {
  const next = [...points, point];
  if (next.length <= maxPoints) {
    return next;
  }
  return next.slice(next.length - maxPoints);
}
