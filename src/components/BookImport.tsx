import { useState } from 'react';
import { bookToScript, parseEbook, type ParsedBook } from '../lib/ebook';

/** A source the importer can read: the bytes plus the name to derive a title from. */
type Source = () => Promise<{ blob: Blob; name: string }>;

function failureText(problem: unknown, fallback: string): string {
  return problem instanceof Error && problem.message ? problem.message : fallback;
}

/**
 * Import an EPUB or text file from a URL or from disk and drop it into the
 * script box. Remote files go through the app's own `/fetch` route, because
 * book servers rarely allow cross-origin reads.
 */
export function BookImport({
  onLoad,
}: {
  onLoad: (text: string, title: string, info?: { book: ParsedBook; indexes: number[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [book, setBook] = useState<ParsedBook | null>(null);
  const [choice, setChoice] = useState('all');

  /** Both sources end in the same place: fetch the bytes, then parse them. */
  async function importBook(source: Source, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setBook(null);
    try {
      // Let the button repaint as "Reading…" before the unzip work starts.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { blob, name } = await source();
      setBook(await parseEbook(blob, name));
      setChoice('all');
    } catch (problem) {
      setError(failureText(problem, fallback));
    } finally {
      setBusy(false);
    }
  }

  function importFromUrl() {
    const target = url.trim();
    if (!target) return;
    return importBook(async () => {
      const response = await fetch(`/fetch?url=${encodeURIComponent(target)}`);
      if (!response.ok) throw new Error((await response.text()) || `The server answered ${response.status}.`);
      return { blob: await response.blob(), name: target.split('/').pop()?.split('?')[0] || 'book.epub' };
    }, 'Could not download that book.');
  }

  function load() {
    if (!book) return;
    const indexes = choice === 'all' ? book.chapters.map((_, index) => index) : [Number(choice)];
    onLoad(bookToScript(book, choice === 'all' ? undefined : indexes), book.title, { book, indexes });
  }

  const count = book?.chapters.length ?? 0;

  return (
    <div className="stack">
      <div className="row between">
        <span className="eyebrow">Ebook</span>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>
          {open ? 'Hide import' : 'Import ebook'}
        </button>
      </div>

      {open && (
        <>
          <label className="field">
            <span>Book URL</span>
            <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'stretch' }}>
              <input
                type="url"
                value={url}
                placeholder="https://…/book.epub or .txt"
                style={{ flex: 1, minWidth: 0 }}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void importFromUrl();
                }}
              />
              <button className="btn" disabled={busy || !url.trim()} onClick={() => void importFromUrl()}>
                {busy ? 'Reading…' : 'Fetch'}
              </button>
            </div>
            <small className="muted">EPUB or plain text — downloaded by this app, so sites without CORS headers work.</small>
          </label>

          <input
            type="file"
            accept=".epub,.txt,application/epub+zip,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void importBook(async () => ({ blob: file, name: file.name }), 'That file could not be read.');
              }
            }}
          />

          {book && (
            <div className="stack">
              <small className="muted">
                <b>{book.title}</b> · {count} chapter{count === 1 ? '' : 's'} · {book.words.toLocaleString()}{' '}
                words
              </small>
              <label className="field">
                <span>What to narrate</span>
                <select value={choice} onChange={(event) => setChoice(event.target.value)}>
                  <option value="all">Whole book ({count} chapters)</option>
                  {book.chapters.map((chapter, index) => (
                    <option key={index} value={index}>
                      {index + 1}. {chapter.title}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn small" onClick={load}>
                Load into script
              </button>
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </>
      )}
    </div>
  );
}
