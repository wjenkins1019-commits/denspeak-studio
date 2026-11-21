import { useId, useMemo, useRef, useState } from 'react';
import { eqResponse, type EqBand } from '../lib/eq';

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 22, right: 18, bottom: 34, left: 46 };
const MAX_DB = 18;
const MIN_HZ = 20;
const MAX_HZ = 20_000;
const DB_LINES = [-18, -12, -6, 0, 6, 12, 18];
const DB_LABELS = [-12, 0, 12];
const HZ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10_000];
const HZ_LABELS = [100, 1000, 10_000];

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
  if (hz < 1000) return `${Math.round(hz)}`;
  const thousands = hz / 1000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
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
 *
 * The plot reads like a mixing-console EQ: a dark canvas, a fine tick grid, one
 * glowing curve with a translucent fill beneath it, and ringed nodes that light
 * up as you reach for them.
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
  // Ids must be unique per graph: two panels on one page would otherwise share
  // the first one's gradients.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const curve = useMemo(() => eqResponse(bands), [bands]);

  const line = curve
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${xFor(point.hz).toFixed(1)},${yFor(point.db).toFixed(1)}`,
    )
    .join(' ');
  // Filled to the floor of the plot, like a console EQ: the curve is the bright
  // edge of a soft wash rather than a band floating between two hard lines.
  const floor = (HEIGHT - PAD.bottom).toFixed(1);
  const area = `${line} L${xFor(MAX_HZ).toFixed(1)},${floor} L${xFor(MIN_HZ).toFixed(1)},${floor} Z`;

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
        <linearGradient id={`${uid}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-2)" />
        </linearGradient>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="0.36" />
          <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {DB_LINES.map((db) => (
        <line
          key={db}
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={yFor(db)}
          y2={yFor(db)}
          className={db === 0 ? 'eq-zero' : 'eq-grid'}
        />
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

      {HZ_LINES.map((hz) => (
        <line
          key={`tick-${hz}`}
          x1={xFor(hz)}
          x2={xFor(hz)}
          y1={HEIGHT - PAD.bottom}
          y2={HEIGHT - PAD.bottom + 5}
          className="eq-tick"
        />
      ))}

      {DB_LABELS.map((db) => (
        <text key={db} x={PAD.left - 10} y={yFor(db) + 3.5} textAnchor="end">
          {db > 0 ? `+${db}` : db < 0 ? `−${Math.abs(db)}` : '0'}
        </text>
      ))}

      {HZ_LABELS.map((hz) => (
        <text key={hz} x={xFor(hz)} y={HEIGHT - PAD.bottom + 19} textAnchor="middle">
          {formatHz(hz)}
        </text>
      ))}

      <path d={area} fill={`url(#${uid}-fill)`} />
      <path
        d={line}
        className="eq-curve"
        fill="none"
        stroke={`url(#${uid}-stroke)`}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {bands.map((band, index) => {
        const passFilter = band.type === 'highPass' || band.type === 'lowPass';
        const color = nodeColor(band.type);
        const cx = xFor(band.frequency);
        const cy = yFor(passFilter ? 0 : band.gainDb);
        const active = dragging === index;
        const readout = `${formatHz(band.frequency)} · ${band.gainDb > 0 ? '+' : ''}${band.gainDb.toFixed(1)} dB`;
        const chipW = 108;
        const chipX = Math.min(WIDTH - PAD.right - chipW, Math.max(PAD.left, cx - chipW / 2));
        const chipY = Math.max(4, cy - 36);

        return (
          <g key={`${band.type}-${index}`} className={active ? 'eq-band dragging' : 'eq-band'}>
            <circle
              className="eq-halo"
              cx={cx}
              cy={cy}
              r={15}
              fill={color}
              fillOpacity={0.2}
              pointerEvents="none"
            />
            <circle
              cx={cx}
              cy={cy}
              r={active ? 9 : 7}
              fill="var(--surface)"
              stroke={active ? 'var(--text)' : color}
              strokeWidth={2.5}
              pointerEvents="none"
            />
            <circle cx={cx} cy={cy} r={2.4} fill={color} pointerEvents="none" />

            {active && (
              <g className="eq-readout">
                <rect
                  x={chipX}
                  y={chipY}
                  width={chipW}
                  height={22}
                  rx={11}
                  fill="var(--surface)"
                  stroke="var(--line)"
                />
                <text x={chipX + chipW / 2} y={chipY + 15} textAnchor="middle">
                  {readout}
                </text>
              </g>
            )}

            {/* A generous invisible handle, so a node is easy to grab. */}
            <circle
              cx={cx}
              cy={cy}
              r={16}
              fill="transparent"
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
          </g>
        );
      })}
    </svg>
  );
}
