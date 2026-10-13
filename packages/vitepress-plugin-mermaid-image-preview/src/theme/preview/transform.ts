export interface Point {
  x: number;
  y: number;
}
export interface View extends Point {
  scale: number;
}

export function zoomAt(view: View, factor: number, point = { x: 0, y: 0 }) {
  const scale = Math.min(8, Math.max(0.1, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

export function gesture(view: View, before: Point[], after: Point[], origin: Point): View {
  if (!before.length || before.length !== after.length) return view;
  if (before.length === 1)
    return { ...view, x: view.x + after[0].x - before[0].x, y: view.y + after[0].y - before[0].y };
  const center = (points: Point[]) => ({
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2,
  });
  const distance = (points: Point[]) =>
    Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  const from = center(before);
  const to = center(after);
  const previousDistance = distance(before);
  const zoomed = zoomAt(view, previousDistance ? distance(after) / previousDistance : 1, {
    x: from.x - origin.x,
    y: from.y - origin.y,
  });
  return { ...zoomed, x: zoomed.x + to.x - from.x, y: zoomed.y + to.y - from.y };
}
