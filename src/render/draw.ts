import type { World } from '../sim/world';
import { photonEVForDrag } from '../sim/world';
import { photonFromEnergyEV } from '../engine/spectra';
import { kineticEV, type Core, type Photon } from '../sim/atom';
import { elementColor } from '../data/elements';
import { clamp } from '../sim/units';

export interface View {
  /** Pixels per ångström. */
  scale: number;
  panX: number;
  panY: number;
  width: number;
  height: number;
}

export const DEFAULT_SCALE = 22;
export const MIN_SCALE = 1.1;
export const MAX_SCALE = 220;

export interface AimLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  tool: 'proton' | 'electron' | 'neutron' | 'atom' | 'photon';
  symbol?: string;
  massU: number;
  /** Å/fs of launch speed per Å of drag. */
  gain: number;
}

const ELECTRON_COLOR = '#5db2ff';
const PROTON_COLOR = '#ff7a6b';
const NEUTRON_COLOR = '#aeb8c6';

/** Colours for radiation the eye cannot see, so a gamma ray still reads on screen. */
const REGION_TINT: Record<string, [number, number, number]> = {
  gamma: [255, 255, 255],
  'X-ray': [196, 214, 255],
  ultraviolet: [155, 122, 255],
  infrared: [176, 84, 66],
  microwave: [120, 92, 74],
  radio: [96, 104, 116],
};

export function screenToWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.panX) / view.scale, y: (sy - view.panY) / view.scale };
}

export function worldToScreen(view: View, x: number, y: number): { x: number; y: number } {
  return { x: view.panX + x * view.scale, y: view.panY + y * view.scale };
}

/** Zoom keeping the world point under (sx, sy) pinned to the cursor. */
export function zoomViewAt(view: View, sx: number, sy: number, factor: number): View {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / view.scale;
  return { ...view, scale, panX: sx - (sx - view.panX) * k, panY: sy - (sy - view.panY) * k };
}

export function panViewBy(view: View, dxPx: number, dyPx: number): View {
  return { ...view, panX: view.panX + dxPx, panY: view.panY + dyPx };
}

/** Resize the viewport without moving whatever sits at its centre. */
export function resizeView(view: View, width: number, height: number): View {
  const centre = screenToWorld(view, view.width / 2, view.height / 2);
  return { ...view, width, height, panX: width / 2 - centre.x * view.scale, panY: height / 2 - centre.y * view.scale };
}

/** Fit every body in view, or return to default magnification when the sandbox is empty. */
export function frameView(view: View, points: { x: number; y: number }[]): View {
  if (points.length === 0) {
    const centre = screenToWorld(view, view.width / 2, view.height / 2);
    return { ...view, scale: DEFAULT_SCALE, panX: view.width / 2 - centre.x * DEFAULT_SCALE, panY: view.height / 2 - centre.y * DEFAULT_SCALE };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const marginPx = 70;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = clamp(
    Math.min((view.width - marginPx * 2) / spanX, (view.height - marginPx * 2) / spanY),
    MIN_SCALE,
    MAX_SCALE,
  );
  return { ...view, scale, panX: view.width / 2 - (minX + spanX / 2) * scale, panY: view.height / 2 - (minY + spanY / 2) * scale };
}

/** A grid cell of 1, 2 or 5 × 10ⁿ ångström that lands near 110 px wide. */
export function gridStepA(scale: number): number {
  const target = 110 / scale;
  const base = 10 ** Math.floor(Math.log10(target));
  const mantissa = target / base;
  return (mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1) * base;
}

export function scaleBarA(scale: number): number {
  const step = gridStepA(scale);
  let multiple = 1;
  while (step * scale * multiple < 90 && multiple < 8) multiple += 1;
  return step * multiple;
}

function formatÅngström(value: number): string {
  if (value >= 1000) return `${value / 1000} nm`;
  if (value >= 1) return `${value} Å`;
  return `${value * 1000} pm`;
}

/** Marker glyphs grow with the camera, but far less steeply than real distances. */
function glyph(view: View): number {
  return clamp(view.scale / DEFAULT_SCALE, 0.5, 2.4);
}

function visible(view: View, x: number, y: number, pad: number): boolean {
  const p = worldToScreen(view, x, y);
  return p.x > -pad && p.y > -pad && p.x < view.width + pad && p.y < view.height + pad;
}

function cameraBounds(view: View): { x0: number; y0: number; x1: number; y1: number } {
  const a = screenToWorld(view, 0, 0);
  const b = screenToWorld(view, view.width, view.height);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

export function drawWorld(ctx: CanvasRenderingContext2D, world: World, view: View, aim: AimLine | null): void {
  const { width, height } = view;
  ctx.clearRect(0, 0, width, height);
  drawBackdrop(ctx, view);
  ctx.save();
  ctx.strokeStyle = 'rgba(159, 224, 197, 0.75)';
  ctx.lineWidth = 2.5;
  for (const bond of world.bonds) {
    const a = worldToScreen(view, bond.a.x, bond.a.y);
    const b = worldToScreen(view, bond.b.x, bond.b.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(1e-3, Math.hypot(dx, dy));
    // One line per shared pair, offset sideways and tucked in at the ends, which is how
    // a structural formula draws σ, σ+π and σ+2π.
    const nx = (-dy / length) * 3.4 * glyph(view);
    const ny = (dx / length) * 3.4 * glyph(view);
    for (let line = 0; line < bond.order; line++) {
      const away = line - (bond.order - 1) / 2;
      const tuck = away === 0 ? 0 : 0.09;
      ctx.beginPath();
      ctx.moveTo(a.x + nx * away + dx * tuck, a.y + ny * away + dy * tuck);
      ctx.lineTo(b.x + nx * away - dx * tuck, b.y + ny * away - dy * tuck);
      ctx.stroke();
    }
  }
  ctx.restore();
  for (const core of world.cores) {
    // A bare nucleus has no cloud to show, and drawing one would be a lie about the mode.
    if (!world.subatomicMode) drawAtomHalo(ctx, core, view);
  }
  for (const burst of world.nuclearBursts) drawNuclearBurst(ctx, burst, view);
  for (const photon of world.photons) {
    if (visible(view, photon.x, photon.y, 220)) drawPhoton(ctx, photon, view);
  }
  for (const electron of world.electrons) {
    if (visible(view, electron.x, electron.y, 60)) drawParticle(ctx, electron.x, electron.y, electron.vx, electron.vy, view, ELECTRON_COLOR, 2.6 * glyph(view));
  }
  for (const neutron of world.neutrons) {
    if (visible(view, neutron.x, neutron.y, 60)) drawParticle(ctx, neutron.x, neutron.y, neutron.vx, neutron.vy, view, NEUTRON_COLOR, 4.6 * glyph(view));
  }
  for (const core of world.cores) {
    if (visible(view, core.x, core.y, 90)) drawCore(ctx, core, view, world.subatomicMode);
  }
  for (const ray of world.nuclearRays) {
    if (visible(view, ray.x, ray.y, 160)) drawNuclearRay(ctx, ray, view);
  }
  for (const burst of world.nuclearBursts) drawNuclearEventLabel(ctx, burst, view);
  drawFrame(ctx, world, view);
  if (aim) drawAim(ctx, aim, view);
}

function drawBackdrop(ctx: CanvasRenderingContext2D, view: View): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, view.height);
  gradient.addColorStop(0, '#070b13');
  gradient.addColorStop(1, '#04060c');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, view.width, view.height);

  const box = cameraBounds(view);
  const step = gridStepA(view.scale);
  const line = step * view.scale;
  ctx.save();
  ctx.lineWidth = 1;
  for (let x = Math.floor(box.x0 / step) * step; x <= box.x1; x += step) {
    const sx = Math.round(worldToScreen(view, x, 0).x) + 0.5;
    ctx.strokeStyle = Math.abs(x) < step / 2 ? 'rgba(140, 190, 250, 0.22)' : 'rgba(120, 160, 220, 0.10)';
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, view.height);
    ctx.stroke();
  }
  for (let y = Math.floor(box.y0 / step) * step; y <= box.y1; y += step) {
    const sy = Math.round(worldToScreen(view, 0, y).y) + 0.5;
    ctx.strokeStyle = Math.abs(y) < step / 2 ? 'rgba(140, 190, 250, 0.22)' : 'rgba(120, 160, 220, 0.10)';
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(view.width, sy);
    ctx.stroke();
  }
  // The cell size is printed faintly so a zoomed-in grid still says what it measures — but only
  // where there is room for it, because in the top-left corner a phone puts the title instead.
  if (line >= 40 && view.width >= 560) {
    ctx.fillStyle = 'rgba(120, 160, 220, 0.16)';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${formatÅngström(step)}`, 6, 6);
  }
  ctx.restore();
}

function drawFrame(ctx: CanvasRenderingContext2D, world: World, view: View): void {
  ctx.save();
  if (world.wallsOn) {
    const a = worldToScreen(view, 0, 0);
    const b = worldToScreen(view, world.width, world.height);
    ctx.strokeStyle = 'rgba(140, 180, 240, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  // Scale bar pinned to the viewport, because the world has no edges any more.
  const barA = scaleBarA(view.scale);
  const right = view.width - 16;
  const y = view.height - 16;
  const x0 = right - barA * view.scale;
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.5)';
  ctx.fillStyle = 'rgba(200, 220, 255, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(right, y);
  ctx.moveTo(x0, y - 4);
  ctx.lineTo(x0, y + 4);
  ctx.moveTo(right, y - 4);
  ctx.lineTo(right, y + 4);
  ctx.stroke();
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(formatÅngström(barA), (x0 + right) / 2, y - 7);
  ctx.restore();
}

/** Faint cloud showing how far the atom's outermost electron reaches. */
function drawAtomHalo(ctx: CanvasRenderingContext2D, core: Core, view: View): void {
  const radiusA = atomRadiusA(core);
  const centre = worldToScreen(view, core.x, core.y);
  const r = radiusA * view.scale;
  if (r < 2) return;
  ctx.save();
  const glow = ctx.createRadialGradient(centre.x, centre.y, r * 0.2, centre.x, centre.y, r);
  glow.addColorStop(0, 'rgba(90, 140, 220, 0.10)');
  glow.addColorStop(1, 'rgba(90, 140, 220, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 170, 240, 0.16)';
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function atomRadiusA(core: Core): number {
  let radius = 0.4;
  for (let i = 0; i < core.levels.length; i++) {
    if (core.counts[i] > 0) radius = Math.max(radius, core.levels[i].radiusA);
  }
  return radius;
}

function drawCore(ctx: CanvasRenderingContext2D, core: Core, view: View, subatomic: boolean): void {
  const centre = worldToScreen(view, core.x, core.y);
  const g = glyph(view);
  const size = clamp((4 + Math.cbrt(core.massU) * 2.1) * g, 3, 40);
  const colour = core.symbol === 'p' ? PROTON_COLOR : elementColor(core.symbol);
  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = 12;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = core.qNet > 0 ? 'rgba(255, 210, 120, 0.9)' : core.qNet < 0 ? 'rgba(140, 255, 200, 0.9)' : 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = core.qNet === 0 ? 1 : 2;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, size + 2.5 * g, 0, Math.PI * 2);
  ctx.stroke();
  const radioactive = core.nuclear.status === 'radioactive';
  if (radioactive) {
    const phase = Number.isFinite(core.nuclear.remainingSeconds) ? core.nuclear.remainingSeconds * Math.PI * 2 : 0;
    const pulse = (1 + Math.sin(phase + core.id)) / 2;
    ctx.strokeStyle = `rgba(255, 168, 87, ${0.5 + pulse * 0.4})`;
    ctx.lineWidth = (1.3 + pulse * 0.5) * g;
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = phase % 7;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, size + (6 + pulse * 1.5) * g, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  ctx.textAlign = 'center';
  if (!subatomic) {
    // The symbol is the one label this mode throws away: in subatomic mode a nucleus is
    // a lump of protons and neutrons, not an element with a shell structure.
    ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
    ctx.font = `600 ${Math.max(6, Math.min(34, size * 1.15))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(core.symbol, centre.x, centre.y + 0.5);
  }
  if (g < 0.8) {
    // Zoomed out, the nuclei are the only text worth keeping.
    ctx.restore();
    return;
  }
  ctx.fillStyle = radioactive ? '#ffbd82' : 'rgba(200, 215, 235, 0.65)';
  ctx.font = `${Math.round(10 * g)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText(`A=${core.a}`, centre.x, centre.y + size + 10 * g);
  if (!subatomic && core.lastLineNm != null) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = `${Math.round(10 * g)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${core.lastLineNm < 1 ? `${(core.lastLineNm * 1000).toFixed(0)} pm` : `${core.lastLineNm.toFixed(0)} nm`}`, centre.x, centre.y - size - 6 * g);
  }
  ctx.restore();
}

function nuclearColour(mode: string): string {
  if (mode === 'fission') return '#ffd28a';
  if (mode === 'alpha') return '#ff9b63';
  if (mode === 'beta−' || mode === 'double beta−') return '#70ead2';
  if (mode === 'beta+') return '#ff97cc';
  if (mode === 'neutrino' || mode === 'antineutrino' || mode === 'electron capture') return '#baa6ff';
  return '#c6d6ec';
}

function drawNuclearBurst(ctx: CanvasRenderingContext2D, burst: World['nuclearBursts'][number], view: View): void {
  const t = clamp(burst.ageSeconds / 1.6, 0, 1);
  if (t >= 1) return;
  const centre = worldToScreen(view, burst.x, burst.y);
  if (centre.x < -320 || centre.y < -320 || centre.x > view.width + 320 || centre.y > view.height + 320) return;
  const fission = burst.mode === 'fission';
  const alpha = burst.mode === 'alpha';
  const colour = nuclearColour(burst.mode);
  const g = glyph(view);
  const reach = fission ? clamp(view.scale * 5.5, 80, 145) * g : (alpha ? 48 : 32) * g;
  const radius = 9 * g + Math.sqrt(t) * reach;
  const fade = Math.pow(1 - t, 1.3);
  ctx.save();
  const glow = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
  glow.addColorStop(0, `${colour}66`);
  glow.addColorStop(0.3, `${colour}28`);
  glow.addColorStop(1, `${colour}00`);
  ctx.globalAlpha = fade * (fission ? 1 : 0.5);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = fade * 0.85;
  ctx.strokeStyle = colour;
  ctx.lineWidth = fission ? 2.4 : 1.2;
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (fission) {
    ctx.globalAlpha = fade * 0.35;
    ctx.setLineDash([5, 9]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const sparks = fission ? 22 : alpha ? 6 : 4;
  ctx.lineCap = 'round';
  for (let i = 0; i < sparks; i++) {
    const angle = i * Math.PI * 2 / sparks + burst.id * 2.39996;
    const scatter = 0.7 + (Math.sin(i * 13.7 + burst.id) + 1) * 0.22;
    const outer = radius * scatter;
    const inner = Math.max(5, outer - (fission ? 12 + 22 * t : 4 + 5 * t));
    ctx.globalAlpha = fade * (i % 3 === 0 ? 0.9 : 0.55);
    ctx.lineWidth = fission && i % 3 === 0 ? 2.5 : 1.2;
    ctx.strokeStyle = fission && i % 3 === 0 ? '#fff0d6' : colour;
    ctx.beginPath();
    ctx.moveTo(centre.x + Math.cos(angle) * inner, centre.y + Math.sin(angle) * inner);
    ctx.lineTo(centre.x + Math.cos(angle) * outer, centre.y + Math.sin(angle) * outer);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNuclearEventLabel(ctx: CanvasRenderingContext2D, burst: World['nuclearBursts'][number], view: View): void {
  const fade = clamp((1.6 - burst.ageSeconds) / 0.55, 0, 1);
  if (fade <= 0) return;
  // A decay that happened off-camera should not leave a label floating at the edge of the screen.
  if (!visible(view, burst.x, burst.y, 60)) return;
  const centre = worldToScreen(view, burst.x, burst.y);
  const maxWidth = Math.max(1, Math.min(360, view.width - 24));
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 11px ui-monospace, Menlo, monospace';
  const mode = burst.mode === 'fission' ? 'FISSION' : burst.mode;
  const labelWidth = Math.min(maxWidth, Math.max(ctx.measureText(mode).width, ctx.measureText(burst.label).width));
  const x = clamp(centre.x, labelWidth / 2 + 12, view.width - labelWidth / 2 - 12);
  const y = clamp(centre.y - 44, 18, Math.max(18, view.height - 30));
  ctx.strokeStyle = 'rgba(4, 6, 12, 0.85)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.fillStyle = nuclearColour(burst.mode);
  ctx.strokeText(mode, x, y, maxWidth);
  ctx.fillText(mode, x, y, maxWidth);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#d8e1ef';
  ctx.strokeText(burst.label, x, y + 14, maxWidth);
  ctx.fillText(burst.label, x, y + 14, maxWidth);
  ctx.restore();
}

function drawNuclearRay(ctx: CanvasRenderingContext2D, ray: World['nuclearRays'][number], view: View): void {
  const fade = clamp((3 - ray.ageSeconds) / 0.65, 0, 1);
  if (fade <= 0) return;
  const point = worldToScreen(view, ray.x, ray.y);
  const speed = Math.hypot(ray.vx, ray.vy);
  const ux = speed > 0 ? ray.vx / speed : 1;
  const uy = speed > 0 ? ray.vy / speed : 0;
  const length = Math.min(110, speed * Math.max(0, Math.min(ray.ageSeconds, 0.55)) * view.scale);
  const neutrino = ray.kind === 'neutrino' || ray.kind === 'antineutrino';
  const colour = nuclearColour(ray.kind);
  const g = glyph(view);
  ctx.save();
  ctx.globalAlpha = fade * (neutrino ? 0.65 : 0.85);
  ctx.strokeStyle = colour;
  ctx.lineWidth = (neutrino || ray.kind === 'electron' ? 1.2 : 2) * g;
  ctx.lineCap = 'round';
  ctx.setLineDash(neutrino ? [2, 7] : ray.kind === 'electron' ? [5, 3] : []);
  ctx.beginPath();
  ctx.moveTo(point.x - ux * length, point.y - uy * length);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = neutrino ? 0 : 9;
  ctx.beginPath();
  if (ray.kind === 'beta+') {
    ctx.moveTo(point.x, point.y - 3.5 * g);
    ctx.lineTo(point.x + 3.5 * g, point.y);
    ctx.lineTo(point.x, point.y + 3.5 * g);
    ctx.lineTo(point.x - 3.5 * g, point.y);
    ctx.closePath();
  } else {
    ctx.arc(point.x, point.y, (neutrino ? 2.5 : 3) * g, 0, Math.PI * 2);
  }
  if (neutrino) ctx.stroke();
  else ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = `${Math.round(10 * g)}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const label = ray.kind === 'electron' ? 'e− nuclear' : ray.kind;
  ctx.strokeStyle = 'rgba(4, 6, 12, 0.8)';
  ctx.lineWidth = 3;
  ctx.strokeText(label, point.x + 7 * g, point.y - 7 * g);
  ctx.fillText(label, point.x + 7 * g, point.y - 7 * g);
  ctx.restore();
}

function drawParticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  vx: number,
  vy: number,
  view: View,
  colour: string,
  size: number,
): void {
  const p = worldToScreen(view, x, y);
  const speed = Math.hypot(vx, vy);
  ctx.save();
  if (speed > 0.02) {
    const tail = clamp(speed * 0.02 * view.scale, 3, 40);
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = Math.max(1, size * 0.7);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - (vx / speed) * tail, p.y - (vy / speed) * tail);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.shadowColor = colour;
  ctx.shadowBlur = 10;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A photon is drawn as a short wave packet: the colour is its real spectral
 * colour, and the squiggle spacing tracks the real wavelength on a log scale so
 * violet really is tighter than red.
 */
function drawPhoton(ctx: CanvasRenderingContext2D, photon: Photon, view: View): void {
  const rgb = photon.region === 'visible' ? photon.rgb : REGION_TINT[photon.region] ?? photon.rgb;
  const css = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const head = worldToScreen(view, photon.x, photon.y);
  const speed = Math.hypot(photon.vx, photon.vy) || 1;
  const ux = photon.vx / speed;
  const uy = photon.vy / speed;
  const pxPerA = view.scale;
  const cycles = clamp(Math.pow(500 / Math.max(1, photon.wavelengthNm), 0.55), 0.6, 6);
  // The packet stays a readable screen-space squiggle however far the camera is zoomed.
  const length = clamp(pxPerA * 5.5, 45, 190);
  const amplitude = 4.2 * clamp(pxPerA / DEFAULT_SCALE, 0.65, 1.8);
  ctx.save();
  ctx.strokeStyle = css;
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const along = -t * length;
    const wiggle = Math.sin(photon.phase - t * cycles * Math.PI * 2) * amplitude * (1 - t * 0.65);
    const x = head.x + ux * along - uy * wiggle;
    const y = head.y + uy * along + ux * wiggle;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowColor = css;
  ctx.shadowBlur = photon.region === 'visible' ? 14 : 8;
  ctx.fillStyle = css;
  ctx.beginPath();
  ctx.arc(head.x, head.y, (photon.region === 'visible' ? 3 : 2.2) * clamp(pxPerA / DEFAULT_SCALE, 0.6, 1.6), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAim(ctx: CanvasRenderingContext2D, aim: AimLine, view: View): void {
  const from = worldToScreen(view, aim.fromX, aim.fromY);
  const to = worldToScreen(view, aim.toX, aim.toY);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - 0.4) * 9, to.y - Math.sin(angle - 0.4) * 9);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle + 0.4) * 9, to.y - Math.sin(angle + 0.4) * 9);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  const dragA = Math.hypot(aim.toX - aim.fromX, aim.toY - aim.fromY);
  if (aim.tool === 'photon') {
    // Light has no launch speed to show; what the drag buys is energy, and the readout says
    // which rung of the spectrum that lands on.
    const light = photonFromEnergyEV(photonEVForDrag(dragA));
    ctx.fillText(`γ ${photonEnergyLabel(light.energyEV)} · ${wavelengthLabel(light.wavelengthNm)} ${light.region}`, to.x + 8, to.y - 6);
    ctx.restore();
    return;
  }
  const speed = dragA * aim.gain;
  const label = aim.tool === 'atom' ? aim.symbol ?? 'atom' : aim.tool;
  ctx.fillText(
    `${label} → ${speed.toFixed(2)} Å/fs · ${kineticEV(aim.massU, speed, 0).toFixed(2)} eV`,
    to.x + 8,
    to.y - 6,
  );
  ctx.restore();
}

/** Photon energy read the way the notes read it: eV until it stops fitting, then keV and MeV. */
function photonEnergyLabel(energyEV: number): string {
  if (energyEV >= 1e6) return `${(energyEV / 1e6).toPrecision(3)} MeV`;
  if (energyEV >= 1e3) return `${(energyEV / 1e3).toPrecision(3)} keV`;
  if (energyEV < 0.01) return `${energyEV.toExponential(1)} eV`;
  return `${energyEV.toFixed(2)} eV`;
}

function wavelengthLabel(nm: number): string {
  if (nm >= 1e6) return `${(nm / 1e9).toPrecision(3)} m`;
  if (nm >= 1e3) return `${(nm / 1e6).toPrecision(3)} mm`;
  if (nm >= 1) return `${nm.toFixed(nm >= 100 ? 0 : 1)} nm`;
  if (nm >= 1e-3) return `${(nm * 1e3).toFixed(2)} pm`;
  return `${nm * 1e6 < 1 ? (nm * 1e6).toExponential(1) : (nm * 1e6).toFixed(1)} fm`;
}
