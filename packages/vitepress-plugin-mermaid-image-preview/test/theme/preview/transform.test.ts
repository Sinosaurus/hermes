import { expect, test } from 'vitest';
import { gesture, zoomAt } from '../../../src/theme/preview/transform';

test('cursor-centered zoom preserves the content point after panning', () => {
  const view = { scale: 1, x: 30, y: -20 };
  const point = { x: 100, y: 60 };
  const result = zoomAt(view, 2, point);
  expect((point.x - result.x) / result.scale).toBe((point.x - view.x) / view.scale);
  expect((point.y - result.y) / result.scale).toBe((point.y - view.y) / view.scale);
  expect(zoomAt(result, 0.5, point)).toEqual(view);
});

test('zoom bounds do not move an image when already at the limit', () => {
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 100).scale).toBe(8);
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.001).scale).toBe(0.1);
  const view = { scale: 8, x: 40, y: -20 };
  expect(zoomAt(view, 2, { x: 100, y: 60 })).toEqual(view);
});

test('single-pointer drag and two-pointer pinch support zoom and moving the midpoint', () => {
  const view = { scale: 1, x: 0, y: 0 };
  expect(gesture(view, [{ x: 10, y: 20 }], [{ x: 40, y: 10 }], { x: 0, y: 0 })).toEqual({
    scale: 1,
    x: 30,
    y: -10,
  });
  expect(
    gesture(
      view,
      [
        { x: 50, y: 100 },
        { x: 150, y: 100 },
      ],
      [
        { x: 20, y: 110 },
        { x: 220, y: 110 },
      ],
      { x: 100, y: 100 },
    ),
  ).toEqual({ scale: 2, x: 20, y: 10 });
  expect(gesture(view, [], [], { x: 0, y: 0 })).toEqual(view);
});
