// The reveal mask and the grains share one moving dune, in viewport coordinates.
export function sandFront(cross, progress) {
  const t = Math.max(0, Math.min(1, progress));
  const travel = t * t * (3 - 2 * t);
  return -.28 + 1.56 * travel + Math.sin(Math.PI * travel) * (
    .055 * Math.sin(cross * 7.2 + t * 2.1) + .025 * Math.sin(cross * 17.6 - t * 3.4)
  );
}
