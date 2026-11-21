import { useMemo } from 'react';
import { allStyles, isCustomStyleId, styleById, type EqBand } from '../lib/eq';
import { EqGraph } from './EqGraph';

/**
 * The EQ panel: a preset picker (with step arrows) sitting above the response
 * curve. Studio and Convert use it read-only; the Shape view passes
 * `onChangeBands`, which makes the curve's nodes draggable.
 */
export function EqPanel({
  presetId,
  bands,
  onPresetChange,
  onChangeBands,
  edited = false,
}: {
  presetId: string;
  bands: EqBand[];
  onPresetChange: (id: string) => void;
  onChangeBands?: (bands: EqBand[]) => void;
  edited?: boolean;
}) {
  // Re-read on every preset change so a preset saved in the Shape view appears
  // in the picker straight away.
  const presets = useMemo(() => allStyles(), [presetId]);
  const preset = styleById(presetId);
  const builtIn = presets.filter((item) => !isCustomStyleId(item.id));
  const saved = presets.filter((item) => isCustomStyleId(item.id));

  function step(direction: 1 | -1) {
    const index = presets.findIndex((item) => item.id === presetId);
    const next = presets[(index + direction + presets.length) % presets.length];
    if (next) onPresetChange(next.id);
  }

  return (
    <div className="stack">
      <div className="eq-preset-row">
        <span className="eyebrow">Preset</span>
        <select
          aria-label="EQ preset"
          value={presetId}
          onChange={(event) => onPresetChange(event.target.value)}
        >
          <optgroup label="Built-in">
            {builtIn.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </optgroup>
          {saved.length > 0 && (
            <optgroup label="Saved">
              {saved.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button className="btn ghost small" title="Previous preset" aria-label="Previous preset" onClick={() => step(-1)}>
          ‹
        </button>
        <button className="btn ghost small" title="Next preset" aria-label="Next preset" onClick={() => step(1)}>
          ›
        </button>
      </div>

      <EqGraph bands={bands} onChangeBands={onChangeBands} label={`${preset.label} response`} />

      <small className="muted">
        <b>{preset.label}</b>
        {edited && ' · edited'} — {preset.description}
      </small>
    </div>
  );
}
