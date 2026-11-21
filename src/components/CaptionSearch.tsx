import { useMemo, useState } from 'react';
import {
  SEARCH_MAX_TOTAL,
  searchCaptions,
  searchTokens,
  splitHighlight,
} from '../lib/captionSearch';
import { formatDuration } from '../lib/format';
import type { Take } from '../lib/library';

/**
 * Full-text search over every take's stored cues: type a word or two, get
 * each cue holding all of them with its take, timestamp and highlighted
 * text, and jump straight to it. Takes without captions contribute nothing —
 * the note under the box points at the backfill button for those.
 */
export function CaptionSearch({
  takes,
  uncaptioned,
  onJump,
}: {
  takes: Take[];
  /** Takes with no stored captions, so the note can say what isn't covered. */
  uncaptioned: number;
  /** Open the take's player and seek to the hit. */
  onJump: (takeId: string, start: number) => void;
}) {
  const [query, setQuery] = useState('');
  const tokens = useMemo(() => searchTokens(query), [query]);
  const hits = useMemo(() => searchCaptions(takes, query), [takes, query]);
  const searching = tokens.length > 0;

  return (
    <div className="stack">
      <input
        type="search"
        aria-label="Search captions"
        placeholder="Search what was said…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searching && (
        <small className="muted" role="status">
          {hits.length === 0
            ? 'No matches in captioned takes.'
            : `${hits.length} match${hits.length === 1 ? '' : 'es'}${
                hits.length >= SEARCH_MAX_TOTAL ? ' — showing the first 50' : ''
              }.`}
          {uncaptioned > 0 &&
            ` ${uncaptioned} take${uncaptioned === 1 ? ' has' : 's have'} no captions yet — backfill above to make ${
              uncaptioned === 1 ? 'it' : 'them'
            } searchable.`}
        </small>
      )}
      {searching && hits.length > 0 && (
        <div className="take-list">
          {hits.map((hit, index) => (
            <div className="take-row" key={`${hit.takeId}-${hit.start}-${index}`}>
              <div className="meta">
                <strong>{hit.takeName}</strong>
                <small>
                  {formatDuration(hit.start)}
                  {hit.speaker ? ` · ${hit.speaker}` : ''}
                  {' · '}
                  {splitHighlight(hit.text, tokens).map((part, partIndex) =>
                    part.hit ? (
                      <mark key={partIndex}>{part.text}</mark>
                    ) : (
                      <span key={partIndex}>{part.text}</span>
                    ),
                  )}
                </small>
              </div>
              <div className="actions">
                <button
                  className="btn ghost small"
                  title={`Open ${hit.takeName} at ${formatDuration(hit.start)}`}
                  onClick={() => onJump(hit.takeId, hit.start)}
                >
                  Hear it
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
