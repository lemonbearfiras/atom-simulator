import type { PointerEvent } from 'react';
import { CATEGORY_COLOR, ELEMENTS, tablePosition } from '../data/elements';
import { nuclearDescription, nuclide } from '../sim/nuclear';

interface Props {
  open: boolean;
  dragging: boolean;
  selected: string;
  onPick: (symbol: string) => void;
  onDragStart: (event: PointerEvent<HTMLButtonElement>, symbol: string) => void;
  onClose: () => void;
}

export function PeriodicTable({ open, dragging, selected, onPick, onDragStart, onClose }: Props) {
  if (!open) return null;
  return (
    <section id="periodic-table" className={`table-panel${dragging ? ' dragging' : ''}`} role="dialog" aria-label="Periodic table">
      <div className="panel-heading">
        <div><h2>Periodic table</h2><p>Drag an atom into the sandbox. Or tap to select, then tap the canvas.</p></div>
        <button className="icon-btn" onClick={onClose} title="Close the table (Esc)" aria-label="Close the table">×</button>
      </div>
      <div className="table-scroll">
        <div className="table-grid">
          {ELEMENTS.map((record) => {
            const { col, row } = tablePosition(record);
            const isotope = nuclide(record.z, record.mostStableA);
            const radioactive = isotope !== null && !isotope.stable && (isotope.halfLifeSeconds ?? 0) > 0;
            return (
              <button key={record.z} className={`cell${selected === record.symbol ? ' picked' : ''}${radioactive ? ' radioactive' : ''}`}
                style={{ gridColumn: col, gridRow: row, background: `${CATEGORY_COLOR[record.category]}22`, borderColor: `${CATEGORY_COLOR[record.category]}66` }}
                aria-label={`${record.name} (${record.symbol})`} aria-pressed={selected === record.symbol}
                title={`${record.z} · ${record.name} · default ${record.symbol}-${record.mostStableA} · ${nuclearDescription(record.z, record.mostStableA)} · ${record.configuration}`}
                onPointerDown={(event) => onDragStart(event, record.symbol)} onClick={() => onPick(record.symbol)}>
                <span className="z">{record.z}</span><span className="sym">{record.symbol}</span>
              </button>
            );
          })}
          <div className="lanthanide-mark" style={{ gridColumn: 3, gridRow: 6 }}>57–71</div>
          <div className="lanthanide-mark" style={{ gridColumn: 3, gridRow: 7 }}>89–103</div>
        </div>
      </div>
      <div className="table-foot">118 elements <span>Swipe the table sideways on small screens · Esc to close</span></div>
    </section>
  );
}
