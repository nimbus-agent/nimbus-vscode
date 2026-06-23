// Compact "x ago" relative time, shared by sidebar views. `now` is injected so
// callers/tests stay deterministic. Future timestamps (clock skew) read as
// "just now".
export function formatRelativeTime(now: number, timestamp: number): string {
  const deltaSec = Math.floor((now - timestamp) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
