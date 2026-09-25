// Keep particle settling and the real text handoff on the same timeline.
export const READER_MOTION = {
  open: { duration: 2400, closeDuration: 1700, start: 0, end: 0.67, stagger: 0.08, handoff: 0.795 },
  page: { duration: 2350, start: 0.08, end: 0.67, stagger: 0.08, release: 0.16, handoff: 0.795 },
};

// Zero velocity and acceleration at both ends, including reversed playback.
export function smoother(start, end, value) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return Math.max(0, Math.min(1, t * t * t * (t * (t * 6 - 15) + 10)));
}
