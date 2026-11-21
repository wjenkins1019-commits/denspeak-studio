import { useMemo, useRef, useState } from 'react';
import { eqResponse, type EqBand } from '../lib/eq';

const WIDTH = 640;
const HEIGHT = 200;
const PAD = { top: 16, right: 12, bottom: 24, left: 40 };
const MAX_DB = 18;
const MIN_HZ = 20;
const MAX_HZ = 20_000;
const DB_LINES = [-18, -12, -6, 0, 6, 12, 18];
const HZ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

function xFor(hz: number): number {
  return PAD.left + (Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * PLOT_W;
}

function hzFor(x: number): number {
  const ratio = Math.min(1, Math.max(0, (x - PAD.left) / PLOT_W));
  return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, ratio);
}

function yFor(db: number): number {
  const clamped = Math.min(MAX_DB, Math.max(-MAX_DB, db));
  return PAD.top + ((MAX_DB - clamped) / (2 * MAX_DB)) * PLOT_H;
}

function dbFor(y: number): number {
  const ratio = Math.min(1, Math.max(0, (y - PAD.top) / PLOT_H));
  return MAX_DB - ratio * 2 * MAX_DB;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}

function nodeColor(type: EqBand['type']): string {
  if (type === 'highPass' || type === 'lowPass') return 'var(--dim)';
  if (type === 'peak') return 'var(--accent-2)';
  return 'var(--warm)';
}

/**
 * Response curve for a set of bands. Read-only in Studio and Convert; in the
 * Shape view pass `onChangeBands` to drag a band node sideways for frequency
 * and up/down for gain (pass filters only move sideways).
 */
export function EqGraph({
  bands,
  onChangeBands,
  label = 'EQ response',
}: {
  bands: EqBand[];
  onChangeBands?: (bands: EqBand[]) => void;
  label?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const curve = useMemo(() => eqResponse(bands), [bands]);

  const line = curve
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xFor(point.hz).toFixed(1)},${yFor(point.db).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${xFor(MAX_HZ).toFixed(1)},${yFor(0).toFixed(1)} L${xFor(MIN_HZ).toFixed(1)},${yFor(0).toFixed(1)} Z`;

  function pointFrom(event: React.PointerEvent) {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return {
      hz: hzFor(((event.clientX - rect.left) / rect.width) * WIDTH),
      db: dbFor(((event.clientY - rect.top) / rect.height) * HEIGHT),
    };
  }

  function moveBand(index: number, event: React.PointerEvent) {
    if (!onChangeBands) return;
    const point = pointFrom(event);
    if (!point) return;

    const band = bands[index];
    const passFilter = band.type === 'highPass' || band.type === 'lowPass';
    const frequency = Math.round(Math.min(MAX_HZ, Math.max(MIN_HZ, point.hz)));
    const gainDb = passFilter
      ? band.gainDb
      : Math.round(Math.min(24, Math.max(-24, point.db)) * 2) / 2;

    if (frequency === band.frequency && gainDb === band.gainDb) return;
    onChangeBands(bands.map((current, i) => (i === index ? { ...current, frequency, gainDb } : current)));
  }

  return (
    <svg
      ref={svgRef}
      className={onChangeBands ? 'eq-graph draggable' : 'eq-graph'}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id="eq-curve" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-2)" />
        </linearGradient>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {DB_LINES.map((db) => (
        <g key={db}>
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={yFor(db)}
            y2={yFor(db)}
            className={db === 0 ? 'eq-zero' : 'eq-grid'}
          />
          {(db === MAX_DB || db === 0 || db === -MAX_DB) && (
            <text x={PAD.left - 8} y={yFor(db) + 3} textAnchor="end">
              {db > 0 ? `+${db}` : db}
            </text>
          )}
        </g>
      ))}

      {HZ_LINES.map((hz) => (
        <line
          key={hz}
          x1={xFor(hz)}
          x2={xFor(hz)}
          y1={PAD.top}
          y2={HEIGHT - PAD.bottom}
          className="eq-grid"
        />
      ))}

      {HZ_LINES.filter((hz) => hz === 100 || hz === 1000 || hz === 10_000).map((hz) => (
        <text key={hz} x={xFor(hz)} y={HEIGHT - 6} textAnchor="middle">
          {formatHz(hz)}
        </text>
      ))}

      <path d={area} fill="url(#eq-fill)" />
      <path d={line} fill="none" stroke="url(#eq-curve)" strokeWidth={2} strokeLinejoin="round" />

      {bands.map((band, index) => {
        const passFilter = band.type === 'highPass' || band.type === 'lowPass';
        const cx = xFor(band.frequency);
        const cy = yFor(passFilter ? 0 : band.gainDb);

        return (
          <g key={`${band.type}-${index}`}>
            <circle
              cx={cx}
              cy={cy}
              r={dragging === index ? 10 : 8}
              fill={nodeColor(band.type)}
              fillOpacity={0.22}
              stroke={nodeColor(band.type)}
              strokeWidth={1.5}
              className={onChangeBands ? 'eq-node draggable' : 'eq-node'}
              onPointerDown={(event) => {
                if (!onChangeBands) return;
                // Capture keeps the drag alive past the node; a browser that
                // refuses it should still let the band move on plain move events.
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  /* no active pointer to capture */
                }
                setDragging(index);
              }}
              onPointerMove={(event) => {
                if (dragging === index) moveBand(index, event);
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
            />
            <circle cx={cx} cy={cy} r={2} fill={nodeColor(band.type)} pointerEvents="none" />
            {dragging === index && (
              <text x={cx} y={cy - 16} textAnchor="middle" className="eq-readout">
                {formatHz(band.frequency)} · {band.gainDb > 0 ? '+' : ''}
                {band.gainDb.toFixed(1)} dB
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
