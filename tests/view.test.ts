import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, frameView, gridStepA, panViewBy, resizeView, scaleBarA,
  screenToWorld, worldToScreen, zoomViewAt, type View,
} from '../src/render/draw';

const view: View = { scale: DEFAULT_SCALE, panX: -140, panY: 60, width: 900, height: 600 };

describe('camera', () => {
  it('round-trips screen and world coordinates through a panned camera', () => {
    for (const point of [{ x: 0, y: 0 }, { x: -250.5, y: 99.25 }, { x: 1234, y: -777 }]) {
      const world = screenToWorld(view, point.x, point.y);
      const back = worldToScreen(view, world.x, world.y);
      expect(back.x).toBeCloseTo(point.x, 9);
      expect(back.y).toBeCloseTo(point.y, 9);
    }
  });

  it('pins the world point under the cursor while zooming', () => {
    const cursor = { x: 612, y: 233 };
    const before = screenToWorld(view, cursor.x, cursor.y);
    const zoomed = zoomViewAt(view, cursor.x, cursor.y, 3.7);
    const after = screenToWorld(zoomed, cursor.x, cursor.y);
    expect(zoomed.scale).toBeCloseTo(DEFAULT_SCALE * 3.7, 6);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('clamps magnification and survives a zoom round trip', () => {
    expect(zoomViewAt(view, 0, 0, 1e6).scale).toBe(MAX_SCALE);
    expect(zoomViewAt(view, 0, 0, 1e-6).scale).toBe(MIN_SCALE);
    const there = zoomViewAt(view, 300, 400, 5);
    const back = zoomViewAt(there, 300, 400, 1 / 5);
    expect(back.scale).toBeCloseTo(view.scale, 9);
    expect(back.panX).toBeCloseTo(view.panX, 6);
    expect(back.panY).toBeCloseTo(view.panY, 6);
  });

  it('pans by whole pixels without touching magnification', () => {
    const moved = panViewBy(view, -120, 45);
    expect(moved.scale).toBe(view.scale);
    expect(screenToWorld(moved, 500, 500).x).toBeCloseTo(screenToWorld(view, 620, 455).x, 9);
  });

  it('keeps the middle of the screen when the viewport is resized', () => {
    const centre = screenToWorld(view, view.width / 2, view.height / 2);
    const grown = resizeView(view, 1200, 800);
    expect(grown.width).toBe(1200);
    expect(grown.height).toBe(800);
    const stillCentre = screenToWorld(grown, grown.width / 2, grown.height / 2);
    expect(stillCentre.x).toBeCloseTo(centre.x, 9);
    expect(stillCentre.y).toBeCloseTo(centre.y, 9);
  });

  it('frames bodies inside the viewport and resets when the sandbox is empty', () => {
    const scattered = [
      { x: -40, y: 5 }, { x: 120, y: -60 }, { x: 12, y: 30 },
    ];
    const fitted = frameView(view, scattered);
    for (const point of scattered) {
      const onScreen = worldToScreen(fitted, point.x, point.y);
      expect(onScreen.x).toBeGreaterThan(0);
      expect(onScreen.x).toBeLessThan(fitted.width);
      expect(onScreen.y).toBeGreaterThan(0);
      expect(onScreen.y).toBeLessThan(fitted.height);
    }
    const centre = worldToScreen(fitted, 40, -15);
    expect(centre.x).toBeCloseTo(fitted.width / 2, 6);
    expect(centre.y).toBeCloseTo(fitted.height / 2, 6);

    const reset = frameView(fitted, []);
    expect(reset.scale).toBe(DEFAULT_SCALE);
    const kept = screenToWorld(reset, reset.width / 2, reset.height / 2);
    const before = screenToWorld(fitted, fitted.width / 2, fitted.height / 2);
    expect(kept.x).toBeCloseTo(before.x, 9);
    expect(kept.y).toBeCloseTo(before.y, 9);
  });

  it('handles a single body as a zoom-to-point rather than a divide by zero', () => {
    const one = frameView(view, [{ x: 800, y: -300 }]);
    expect(Number.isFinite(one.scale)).toBe(true);
    expect(one.scale).toBe(MAX_SCALE);
    const onScreen = worldToScreen(one, 800, -300);
    expect(onScreen.x).toBeGreaterThan(0);
    expect(onScreen.x).toBeLessThan(one.width);
    expect(onScreen.y).toBeGreaterThan(0);
    expect(onScreen.y).toBeLessThan(one.height);
  });

  it('picks a decimal grid step that stays readable at every magnification', () => {
    const mantissas = new Set<number>();
    for (const scale of [MIN_SCALE, 3, 22, 60, DEFAULT_SCALE * 4, MAX_SCALE]) {
      const step = gridStepA(scale);
      expect(step).toBeGreaterThan(0);
      const exponent = Math.floor(Math.log10(step));
      const mantissa = Math.round(step / 10 ** exponent);
      expect([1, 2, 5]).toContain(mantissa);
      mantissas.add(mantissa);
      // The grid should never collapse into noise or stretch into a blank wash.
      expect(step * scale).toBeGreaterThan(10);
      expect(step * scale).toBeLessThan(1200);
    }
    expect(mantissas.size).toBeGreaterThan(1);
  });

  it('draws a scale bar long enough to measure and short enough to fit', () => {
    for (const scale of [MIN_SCALE, 6, DEFAULT_SCALE, 90, MAX_SCALE]) {
      expect(scaleBarA(scale) * scale).toBeGreaterThanOrEqual(72);
      expect(scaleBarA(scale) * scale).toBeLessThan(900);
    }
  });
});
