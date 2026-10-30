import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { photonEVForDrag, World } from './sim/world';
import {
  DEFAULT_SCALE, drawWorld, frameView, panViewBy, resizeView, screenToWorld, zoomViewAt,
  type AimLine, type View,
} from './render/draw';
import { PeriodicTable } from './ui/PeriodicTable';
import { atomicWeightOf } from './data/elements';
import { ELECTRON_MASS_U, NEUTRON_MASS_U, PROTON_MASS_U } from './sim/units';

type ParticleTool = 'proton' | 'electron' | 'neutron' | 'atom';
type Tool = ParticleTool | 'photon' | 'erase';
const LABELS: Record<Tool, string> = { proton: 'p⁺', electron: 'e⁻', neutron: 'n⁰', atom: 'atom', photon: 'γ', erase: '⌫' };

/** A photon dropped from the palette, with nobody to aim it: 2.5 eV is the blue-violet the eye expects from "light". */
const DROP_PHOTON_EV = 2.5;

/** Capture only tracks a pointer across element boundaries; losing it must not cost the drag. */
function capturePointer(event: RPointerEvent): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    /* the browser already released this pointer id */
  }
}

function massOf(tool: Tool, symbol: string): number {
  if (tool === 'electron') return ELECTRON_MASS_U;
  if (tool === 'neutron') return NEUTRON_MASS_U;
  if (tool === 'proton') return PROTON_MASS_U;
  return atomicWeightOf(symbol);
}

function nuclearEnergy(energyEV: number): string {
  if (Math.abs(energyEV) >= 1e6) return `${(energyEV / 1e6).toFixed(2)} MeV`;
  if (Math.abs(energyEV) >= 1e3) return `${(energyEV / 1e3).toFixed(2)} keV`;
  return `${energyEV.toFixed(2)} eV`;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableButtonRef = useRef<HTMLButtonElement>(null);
  const worldRef = useRef<World | null>(null);
  if (!worldRef.current) worldRef.current = new World();
  const world = worldRef.current;
  const viewRef = useRef<View>({ scale: DEFAULT_SCALE, panX: 0, panY: 0, width: 0, height: 0 });
  const aimRef = useRef<AimLine | null>(null);
  const paletteRef = useRef<{ tool: Tool; symbol: string; x: number; y: number; moved: boolean } | null>(null);
  const panRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const touchRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [tool, setTool] = useState<Tool>('electron');
  const [symbol, setSymbol] = useState('H');
  const [subatomic, setSubatomic] = useState(false);
  const [kelvin, setKelvin] = useState(300);
  const [tableOpen, setTableOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [stats, setStats] = useState(() => world.summary());
  const [probe, setProbe] = useState<string | null>(null);
  const settingsRef = useRef({ playing, speed });
  settingsRef.current = { playing, speed };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !wrap || !ctx) return;
    const resize = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const view = viewRef.current;
      viewRef.current = view.width === 0
        ? { scale: DEFAULT_SCALE, panX: 0, panY: 0, width, height }
        : resizeView(view, width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      viewRef.current = zoomViewAt(
        viewRef.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)),
      );
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    let raf = 0;
    let previousTimestamp: number | null = null;
    const frame = (timestamp: number) => {
      const elapsedSeconds = previousTimestamp === null ? 0 : Math.max(0, (timestamp - previousTimestamp) / 1000);
      previousTimestamp = timestamp;
      const view = viewRef.current;
      world.width = view.width / view.scale;
      world.height = view.height / view.scale;
      if (settingsRef.current.playing) world.stepFrame(settingsRef.current.speed, elapsedSeconds);
      drawWorld(ctx, world, viewRef.current, aimRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const timer = window.setInterval(() => {
      setStats(world.summary());
      setZoomPct(Math.round((viewRef.current.scale / DEFAULT_SCALE) * 100));
    }, 220);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      canvas.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, [world]);

  // Subatomic mode belongs to the box; React only mirrors what the control says.
  // The thermostat is not mirrored: `setTemperature` is the one call that both re-tempers the
  // bodies already inside and moves the set point new bodies are released with.
  useEffect(() => { world.setSubatomicMode(subatomic); }, [world, subatomic]);

  const clear = () => {
    world.reset();
    aimRef.current = null;
    paletteRef.current = null;
    setGhost(null);
    setProbe(null);
    setStats(world.summary());
  };

  const zoomBy = (factor: number) => {
    const view = viewRef.current;
    viewRef.current = zoomViewAt(view, view.width / 2, view.height / 2, factor);
  };

  const frameAll = () => {
    const view = viewRef.current;
    viewRef.current = frameView(view, [
      ...world.cores.map((core) => ({ x: core.x, y: core.y })),
      ...world.electrons.map((electron) => ({ x: electron.x, y: electron.y })),
      ...world.neutrons.map((neutron) => ({ x: neutron.x, y: neutron.y })),
    ]);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === 'Escape') {
        setTableOpen(false);
        setNotesOpen(false);
        aimRef.current = null;
        paletteRef.current = null;
        setGhost(null);
        tableButtonRef.current?.focus();
      }
      if (event.key === '1') setTool('proton');
      if (event.key === '2') setTool('electron');
      if (event.key === '3') setTool('neutron');
      if (event.key === '4') setTool('photon');
      if (event.key.toLowerCase() === 's') setSubatomic((on) => !on);
      if (event.key.toLowerCase() === 't') {
        setTableOpen((open) => !open);
        setNotesOpen(false);
      }
      if (event.key === 'f') frameAll();
      if (event.key === '+' || event.key === '=') zoomBy(1.35);
      if (event.key === '-' || event.key === '_') zoomBy(1 / 1.35);
      if (event.key === '0') { zoomBy(DEFAULT_SCALE / viewRef.current.scale); }
      const nudge = 70;
      if (event.key === 'ArrowLeft') viewRef.current = panViewBy(viewRef.current, nudge, 0);
      if (event.key === 'ArrowRight') viewRef.current = panViewBy(viewRef.current, -nudge, 0);
      if (event.key === 'ArrowUp') viewRef.current = panViewBy(viewRef.current, 0, nudge);
      if (event.key === 'ArrowDown') viewRef.current = panViewBy(viewRef.current, 0, -nudge);
      if (event.key.startsWith('Arrow')) event.preventDefault();
      if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setPlaying((run) => !run);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [world]);

  const pointOf = (x: number, y: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return screenToWorld(viewRef.current, x - rect.left, y - rect.top);
  };

  const release = (next: Tool, element: string, x: number, y: number, vx = 0, vy = 0) => {
    if (next === 'photon') {
      world.spawnPhoton(DROP_PHOTON_EV, x, y);
      setStats(world.summary());
      return;
    }
    // The box has a temperature, so what the hand drops arrives already moving with the rest
    // of the gas instead of hanging frozen in the picture.
    const heat = world.thermalVelocity(massOf(next, element));
    const sx = vx + heat.vx;
    const sy = vy + heat.vy;
    if (next === 'atom') world.spawnAtom(element, x, y, sx, sy);
    if (next === 'proton') world.spawnProton(x, y, sx, sy);
    if (next === 'electron') world.spawnElectron(x, y, sx, sy);
    if (next === 'neutron') world.spawnNeutron(x, y, sx, sy);
    setStats(world.summary());
  };

  const startPaletteDrag = (event: RPointerEvent<HTMLButtonElement>, next: Tool, element = symbol) => {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    panRef.current = null;
    aimRef.current = null;
    paletteRef.current = { tool: next, symbol: element, x: event.clientX, y: event.clientY, moved: false };
    capturePointer(event);
  };

  const pick = (next: Tool, element = symbol) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setTool(next);
    setSymbol(element);
    if (next === 'atom') setTableOpen(false);
  };

  const onPointerMove = (event: RPointerEvent) => {
    if (event.pointerType === 'touch' && touchRef.current.has(event.pointerId)) {
      touchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchRef.current.size >= 2) {
        syncPinch();
        return;
      }
    }
    if (!event.isPrimary) return;
    const drag = paletteRef.current;
    if (drag) {
      drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5;
      if (drag.moved) setGhost({ x: event.clientX, y: event.clientY, label: drag.tool === 'atom' ? drag.symbol : LABELS[drag.tool] });
    } else if (aimRef.current) {
      const p = pointOf(event.clientX, event.clientY);
      aimRef.current.toX = p.x;
      aimRef.current.toY = p.y;
    }
  };

  const onPointerUp = (event: RPointerEvent) => {
    if (event.pointerType === 'touch' && touchRef.current.has(event.pointerId)) {
      touchRef.current.delete(event.pointerId);
      if (touchRef.current.size < 2) pinchRef.current = null;
    }
    if (panRef.current && (panRef.current.pointerId === event.pointerId || event.buttons === 0)) panRef.current = null;
    const drag = paletteRef.current;
    paletteRef.current = null;
    setGhost(null);
    if (drag) {
      suppressClick.current = drag.moved;
      if (drag.moved && document.elementFromPoint(event.clientX, event.clientY) === canvasRef.current) {
        const p = pointOf(event.clientX, event.clientY);
        release(drag.tool, drag.symbol, p.x, p.y);
        setTool(drag.tool);
        setSymbol(drag.symbol);
        if (drag.tool === 'atom') setTableOpen(false);
      }
      return;
    }
    const aim = aimRef.current;
    aimRef.current = null;
    if (!aim) return;
    const p = pointOf(event.clientX, event.clientY);
    if (aim.tool === 'photon') {
      // Light does not get faster when you pull harder; the drag buys energy instead.
      const dx = p.x - aim.fromX;
      const dy = p.y - aim.fromY;
      world.spawnPhoton(photonEVForDrag(Math.hypot(dx, dy)), aim.fromX, aim.fromY, Math.atan2(dy, dx));
      setStats(world.summary());
      return;
    }
    release(aim.tool, aim.symbol ?? symbol, aim.fromX, aim.fromY, (p.x - aim.fromX) * aim.gain, (p.y - aim.fromY) * aim.gain);
  };

  const onCanvasPointerDown = (event: RPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      touchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchRef.current.size >= 2) {
        // Two fingers are a camera, not a launch: drop the aim the first finger started.
        aimRef.current = null;
        syncPinch();
        return;
      }
    }
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    if (event.button === 1 || event.shiftKey) {
      capturePointer(event);
      panRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      return;
    }
    const p = pointOf(event.clientX, event.clientY);
    if (tool === 'erase') {
      world.deleteNear(p.x, p.y);
      setStats(world.summary());
      return;
    }
    capturePointer(event);
    if (tool === 'photon') {
      aimRef.current = { fromX: p.x, fromY: p.y, toX: p.x, toY: p.y, tool, symbol, massU: 0, gain: 0 };
      return;
    }
    const massU = massOf(tool, symbol);
    aimRef.current = { fromX: p.x, fromY: p.y, toX: p.x, toY: p.y, tool, symbol, massU,
      gain: 2 * Math.sqrt(ELECTRON_MASS_U / massU) };
  };

  /** Camera drag lives on the canvas alone, so a stale pan state can never swallow another gesture. */
  const onCanvasPointerMove = (event: RPointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      panRef.current = null;
      return;
    }
    viewRef.current = panViewBy(viewRef.current, event.clientX - pan.x, event.clientY - pan.y);
    panRef.current = { ...pan, x: event.clientX, y: event.clientY };
  };

  const onPointerCancel = (event: RPointerEvent) => {
    touchRef.current.delete(event.pointerId);
    if (touchRef.current.size < 2) pinchRef.current = null;
    if (panRef.current && (panRef.current.pointerId === event.pointerId || event.buttons === 0)) panRef.current = null;
    if (event.isPrimary) {
      aimRef.current = null;
      paletteRef.current = null;
      setGhost(null);
    }
  };

  /** Two fingers already down: zoom about the old midpoint, then slide by how far it moved. */
  function syncPinch(): void {
    const [a, b] = [...touchRef.current.values()];
    const canvas = canvasRef.current;
    if (!a || !b || !canvas) { pinchRef.current = null; return; }
    const rect = canvas.getBoundingClientRect();
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    const previous = pinchRef.current;
    if (previous && dist > 4 && previous.dist > 4) {
      const zoomed = zoomViewAt(viewRef.current, previous.x, previous.y, dist / previous.dist);
      viewRef.current = panViewBy(zoomed, mid.x - previous.x, mid.y - previous.y);
    }
    pinchRef.current = { dist, x: mid.x, y: mid.y };
  }

  const empty = stats.cores + stats.electrons + stats.neutrons === 0;
  return (
    <main className="app" ref={wrapRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <canvas ref={canvasRef} className="stage" aria-label="2D particle sandbox"
        onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onContextMenu={(event) => {
          event.preventDefault();
          const p = pointOf(event.clientX, event.clientY);
          setProbe(world.describe(p.x, p.y));
        }} />

      <header className="hud">
        <h1>ATOM SANDBOX <span>2D</span></h1>
        <p>{subatomic
          ? `${stats.cores} nuclei · ${stats.electrons} free e⁻ · ${stats.neutrons} n⁰ · ${stats.photons} photons`
          : `${stats.cores} atoms / nuclei · ${stats.electrons} e⁻ · ${stats.neutrons} n⁰ · ${stats.bonds} bonds`}</p>
        {subatomic && <p className="mode-line">Subatomic mode · no shells, no bonds, no element labels</p>}
        {(stats.radioactive > 0 || stats.nuclearDecays > 0) && <p className="nuclear-timing">Nuclear decay timing compressed</p>}
        {probe && <p className="probe">{probe}</p>}
      </header>

      {empty && <div className="empty-hint"><h2>Drop something in.</h2><p>{subatomic
        ? 'Drag p⁺, e⁻, n⁰ or γ from below.<br />Open the table to drop a bare nucleus.'
        : 'Drag p⁺, e⁻ or n⁰ from below.<br />Open the table to drag in an atom.'}</p></div>}

      <div className="corner-buttons">
        <button ref={tableButtonRef} className={`icon-btn${tableOpen ? ' active' : ''}`} aria-label="Periodic table"
          aria-expanded={tableOpen} aria-controls="periodic-table" title="Periodic table (T)"
          onClick={() => { setTableOpen((open) => !open); setNotesOpen(false); }}>
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 4h5v5h8V4h5v16H3Z M3 9h18 M3 14h18 M8 9v11 M13 9v11 M17 4v16" />
          </svg>
        </button>
        <button className={`icon-btn${notesOpen ? ' active' : ''}`} aria-label="Physics and readings"
          title="Physics and readings" aria-expanded={notesOpen}
          onClick={() => { setNotesOpen((open) => !open); setTableOpen(false); }}>i</button>
        <button className={`icon-btn${subatomic ? ' active' : ''}`} aria-label="Subatomic mode" aria-pressed={subatomic}
          title="Subatomic mode (S): bare nuclei, free particles and light only — no shells, no bonds"
          onClick={() => setSubatomic((on) => !on)}>
          <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="9.5" cy="12" r="3.4" fill="currentColor" stroke="none" />
            <path d="M15 8.6c1.5 1.1 1.5 5.7 0 6.8M18.4 6.4c2.4 1.8 2.4 9.4 0 11.2" />
          </svg>
        </button>
        <div className="camera" role="group" aria-label="Camera">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.35)}>−</button>
          <button className="icon-btn zoom-readout" aria-label={`Zoom ${zoomPct} percent — fit everything in view`}
            title="Fit everything in view (F)" onClick={frameAll}>{zoomPct}%</button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.35)}>+</button>
        </div>
      </div>

      <div className="bottom-controls">
        <p className="drag-hint">{subatomic
          ? 'Drag a nucleus or a γ in · pull a γ farther for a harder photon · scroll to zoom · Shift-drag to pan'
          : 'Drag a particle in · drag on the canvas to launch it · scroll to zoom · Shift-drag or middle-drag to pan'}</p>
        <nav className="toolbar" aria-label="Sandbox controls">
          <div className="tool-group" aria-label="Particles">
            {(['proton', 'electron', 'neutron'] as const).map((next) => (
              <button key={next} className={`tool-btn particle ${next}${tool === next ? ' active' : ''}`}
                aria-label={next[0].toUpperCase() + next.slice(1)} aria-pressed={tool === next}
                title={`Drag in a ${next}, or click to select`} onPointerDown={(event) => startPaletteDrag(event, next)}
                onClick={() => pick(next)}>{LABELS[next]}</button>
            ))}
            <button className={`tool-btn particle photon${tool === 'photon' ? ' active' : ''}`} aria-label="Photon"
              aria-pressed={tool === 'photon'} title="Drag in a photon, or click to select. On the canvas, drag it out: farther pulls a harder photon."
              onPointerDown={(event) => startPaletteDrag(event, 'photon')} onClick={() => pick('photon')}>γ</button>
            {tool === 'atom' && <button className="tool-btn particle active" aria-label={`Selected atom ${symbol}`}
              onPointerDown={(event) => startPaletteDrag(event, 'atom')} onClick={() => pick('atom')}>{symbol}</button>}
          </div>
          <div className="tool-group secondary-tools">
            <button className={`tool-btn${tool === 'erase' ? ' active' : ''}`} title="Erase a particle" aria-label="Erase" aria-pressed={tool === 'erase'} onClick={() => setTool('erase')}>⌫</button>
            <button className="tool-btn" title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((run) => !run)}>{playing ? 'Ⅱ' : '▶'}</button>
            <select aria-label="Simulation speed" title="Simulation speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
              <option value={0.1}>0.1×</option><option value={1}>1×</option><option value={4}>4×</option>
            </select>
            <select aria-label="Temperature" title="Temperature of the box: what you drop arrives moving at this speed, and changing it re-tempers the whole box"
              value={kelvin} onChange={(event) => { const next = Number(event.target.value); setKelvin(next); world.setTemperature(next); }}>
              <option value={0}>still</option><option value={300}>300 K</option><option value={1000}>1000 K</option><option value={5000}>5000 K</option>
            </select>
            <button className="tool-btn clear-btn" title="Clear the sandbox" onClick={clear}>Clear</button>
          </div>
        </nav>
      </div>

      <PeriodicTable open={tableOpen} dragging={ghost !== null} selected={symbol}
        onPick={(next) => pick('atom', next)} onDragStart={(event, next) => startPaletteDrag(event, 'atom', next)}
        onClose={() => { setTableOpen(false); tableButtonRef.current?.focus(); }} />

      {ghost && <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">{ghost.label}</div>}

      {notesOpen && <aside className="notes" aria-label="Physics and readings">
        <div className="panel-heading"><h2>Physics, not magic</h2><button className="icon-btn" aria-label="Close readings" onClick={() => setNotesOpen(false)}>×</button></div>
        <p>A 2D semiclassical model—not a full quantum simulation.</p>
        <ul>
          <li>Charges attract and repel through softened Coulomb forces. Atomic shells screen the nucleus; tabulated energy levels constrain the electron orbits.</li>
          <li>Electronic excitation, capture and relaxation can emit photons with E = hf. Measured lines are used where available; other levels are estimates.</li>
          <li>Bonds carry the measured order the pair's unpaired electrons can pay for — σ, σ+π, σ+2π — with gas-phase D₀, rₑ and stretch constants where the tables have them, deepened to Dₑ by the zero-point energy the molecule keeps. Mean bond enthalpies stand in for molecules, and untabulated pairs are Pauling estimates. Association and vibrational cooling are accelerated approximations, not measured reaction rates. π bonds need an electron that is already unpaired, so a third or fourth partner on carbon costs its 1.5 eV promotion while CO keeps two bonds rather than its real three; resonance, conjugation and molecular orbitals are not modeled.</li>
          <li>Valence is a budget, not a suggestion: a bond spends one shared pair per order, so a doubled oxygen is spent and takes no third partner — there is no O₄ in this box — and an atom that loses an electron mid-molecule sheds its weakest bond rather than holding more pairs than it owns.</li>
          <li>Subatomic mode (S) takes the shells away: what the table drops is a bare nucleus, free electrons scatter rather than being captured, nothing bonds, and nuclei are drawn without their element symbol or spectral line. Decay, neutron capture and injected light keep working. It is a change of model, not a physical process, so bond energy the box was still paying off is written off in the log.</li>
          <li>The box carries a temperature: every body you release arrives with a Maxwell draw from it, so nothing hangs frozen, and changing it re-tempers everything already inside. Thermal speeds are real; association rates are still accelerated.</li>
          <li>Particle sizes and photon travel are enlarged or slowed for visibility. Emission and absorption rates are accelerated. Neutrons are uncharged; this is not a general nuclear-reaction simulator.</li>
          <li>Nuclei use evaluated IAEA LiveChart ground-state data, with the dominant decay channel only. EC+B+ is modeled as electron capture. Table tooltips show the default isotope and real half-life; orange dots and warm dashed rings mark radioactive nuclei.</li>
          <li>Nuclear lifetimes are independently compressed logarithmically to seconds, not tied to the displayed atomic fs. Pause and playback speed also control nuclear decay and its visuals.</li>
          <li>Alpha and beta decay are distinct from fission. Fission splits, electron rearrangement and beta energy sharing are illustrative; excited nuclear levels and their gamma cascades are not modeled. There is no induced-fission model.</li>
          <li>Neutron capture uses isotope-specific separation energies, with an enlarged capture radius and illustrative probability. Missing decay data remains unmodeled, not assumed stable.</li>
          <li>Escaping beta, neutrino and shake-off electron tracks carry modeled energy metadata, but their visual speeds are not physical. These tracks are slowed and do not simulate transport or secondary reactions.</li>
          <li>The nuclear Q release budget is distinct from emitted photon energy. Escaped nuclear radiation is tracked separately, not added again to the Q release.</li>
        </ul>
        <dl className="stats">
          <div><dt>Atomic time</dt><dd>{stats.timeFS.toFixed(1)} fs</dd></div>
          <div><dt>Time per frame</dt><dd>{stats.frameFS.toPrecision(2)} fs{stats.clockDilated ? ' (adaptive)' : ''}</dd></div>
          <div><dt>Mechanical energy</dt><dd>{stats.mechanicalEV.toFixed(2)} eV</dd></div>
          <div><dt>Temperature of motion</dt><dd>{Math.round(stats.temperatureK).toLocaleString()} K</dd></div>
          <div><dt>Emitted photons</dt><dd>{stats.emittedEV.toFixed(2)} eV</dd></div>
          <div><dt>Stored bond energy</dt><dd>{stats.bondBankEV.toFixed(2)} eV</dd></div>
          <div><dt>Free electrons</dt><dd>{stats.freeElectrons}</dd></div>
          <div className="nuclear-readings"><dt>Nuclear decays</dt><dd>{stats.nuclearDecays}</dd></div>
          <div><dt>Nuclear Q released</dt><dd>{nuclearEnergy(stats.nuclearReleasedEV)}</dd></div>
          <div><dt>Escaped nuclear radiation</dt><dd>{nuclearEnergy(stats.nuclearEscapedEV)}</dd></div>
        </dl>
        <h3>Recent events</h3>
        <ul className="events">{world.events.slice(-5).reverse().map((event, index) => <li key={`${event.fs}-${index}`} className={event.tone}>{event.text}</li>)}</ul>
        {world.events.length === 0 && <p>No interactions yet.</p>}
      </aside>}
    </main>
  );
}
