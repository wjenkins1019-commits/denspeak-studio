// Ebook import.
//
// Narration usually starts with a book, not a paragraph, so this reads an EPUB
// or plain-text file into chapters the Studio can load. EPUB is a ZIP of XHTML,
// which is unpacked here with the browser's own DecompressionStream — no zip
// library, no extra dependency.

export interface BookChapter {
  title: string;
  text: string;
}

export interface ParsedBook {
  title: string;
  chapters: BookChapter[];
  words: number;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(view: DataView): number {
  const oldest = Math.max(0, view.byteLength - 66_000);
  for (let offset = view.byteLength - 22; offset >= oldest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readCentralDirectory(buffer: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, ZipEntry>();

  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('That file is not a valid EPUB (no ZIP directory found).');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));

    entries.set(name, { name, method, compressedSize, offset: localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function readZipEntry(entry: ZipEntry, buffer: ArrayBuffer): Promise<Uint8Array> {
  const view = new DataView(buffer);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new Error(`EPUB entry "${entry.name}" is damaged.`);
  }

  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = new Uint8Array(buffer, start, entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`EPUB entry "${entry.name}" uses unsupported compression.`);

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Block-level HTML → plain text, keeping paragraph breaks and dropping markup. */
function htmlToText(doc: Document): string {
  for (const node of doc.querySelectorAll('script, style, svg, nav')) node.remove();

  const blocks = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, pre, li, td')]
    .filter((element) => !(element.tagName === 'LI' && element.querySelector('p')))
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);

  if (blocks.length > 0) return blocks.join('\n\n');

  const fallback = (doc.body?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  return fallback.replace(/\n{3,}/g, '\n\n');
}

function chapterTitleFrom(doc: Document, fallback: string): string {
  const heading = doc.querySelector('h1, h2, h3');
  const title = heading?.textContent?.replace(/\s+/g, ' ').trim() || doc.querySelector('title')?.textContent?.trim();
  return title ? title.slice(0, 120) : fallback;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

async function parseEpub(buffer: ArrayBuffer): Promise<ParsedBook> {
  const entries = readCentralDirectory(buffer);
  const textOf = async (path: string) => {
    const entry = entries.get(path);
    if (!entry) return null;
    return new TextDecoder('utf-8').decode(await readZipEntry(entry, buffer));
  };

  const containerXml = await textOf('META-INF/container.xml');
  if (!containerXml) throw new Error('That EPUB has no META-INF/container.xml.');

  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new Error('That EPUB does not declare a package document.');

  const opfXml = await textOf(rootfile);
  if (!opfXml) throw new Error('That EPUB is missing its package document.');

  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
  const basePath = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const resolve = (href: string) => {
    const decoded = decodeURIComponent(href.split('#')[0]);
    return decoded.startsWith('/') ? decoded.slice(1) : basePath + decoded;
  };

  const manifest = new Map<string, string>();
  for (const item of opfDoc.getElementsByTagName('item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const type = item.getAttribute('media-type') ?? '';
    if (id && href && /x?html/i.test(type)) manifest.set(id, resolve(href));
  }

  const order = [...opfDoc.getElementsByTagName('itemref')]
    .filter((ref) => ref.getAttribute('linear') !== 'no')
    .map((ref) => ref.getAttribute('idref'))
    .filter((id): id is string => typeof id === 'string' && manifest.has(id));

  // Some EPUBs keep everything in one file; walk the manifest if the spine is empty.
  const paths = order.length > 0 ? order.map((id) => manifest.get(id) as string) : [...manifest.values()];

  const chapters: BookChapter[] = [];
  for (const [index, path] of paths.entries()) {
    const markup = await textOf(path);
    if (!markup) continue;

    // One parse per chapter: the heading, the fallback <title> and the body
    // text all come from the same document.
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const text = htmlToText(doc);
    if (countWords(text) < 3) continue;

    chapters.push({ title: chapterTitleFrom(doc, `Section ${index + 1}`), text });
  }

  if (chapters.length === 0) throw new Error('That EPUB has no readable text.');

  const metaTitle = opfDoc.getElementsByTagName('dc:title')[0]?.textContent?.trim();
  const title = metaTitle || chapters[0].title || 'Untitled book';

  return { title, chapters, words: chapters.reduce((sum, chapter) => sum + countWords(chapter.text), 0) };
}

/** Read a .epub or .txt file into chapters. */
export async function parseEbook(blob: Blob, name = 'book'): Promise<ParsedBook> {
  const buffer = await blob.arrayBuffer();

  // EPUB is a ZIP, which starts "PK\x03\x04"; plain text is anything else.
  const signature = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isZip = signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04;

  if (!isZip) {
    const raw = new TextDecoder('utf-8').decode(buffer).replace(/\r\n/g, '\n');

    // Gutenberg files name the book in the header; the file name is often just
    // a catalogue number, so prefer the title the file declares.
    const metaTitle =
      raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ||
      raw.match(/^The Project Gutenberg e-?book of (.+?)(?:,\s*by .+)?\s*$/im)?.[1]?.trim() ||
      raw.match(/^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK\s+(.+?)\s*\*{3}/m)?.[1]?.trim();

    let text = raw;

    // Project Gutenberg books carry a licence header and footer that should not
    // be narrated; everything between the markers is the actual book.
    const startMarker = text.search(/^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
    if (startMarker >= 0) {
      const lineEnd = text.indexOf('\n', startMarker);
      text = lineEnd >= 0 ? text.slice(lineEnd + 1) : '';
    }
    const endMarker = text.search(/^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/m);
    if (endMarker >= 0) text = text.slice(0, endMarker);

    // Gutenberg marks pictures with a bracketed note on its own line; nobody
    // wants the narrator to read "[Illustration]".
    text = text.replace(/^\[(?:Illustration|Image|Frontispiece)[^\]]*\]\s*$/gim, '').trim();
    if (!text) throw new Error('That file looks empty.');

    // Plain text books usually mark chapters with a "CHAPTER" line.
    const parts = text.split(/\n(?=(?:CHAPTER|Chapter)\s+[IVXLC\d]+)/g).filter((part) => part.trim());
    const chapters =
      parts.length > 1
        ? parts.map((part, index) => ({
            title: part.split('\n')[0].trim().replace(/[.:;,\s\]]+$/, '').slice(0, 120) || `Section ${index + 1}`,
            text: part.trim(),
          }))
        : [{ title: name.replace(/\.[^.]+$/, ''), text }];

    const fileTitle = name.replace(/\.[^.]+$/, '');
    const title = metaTitle && !/^\d+$/.test(metaTitle) ? metaTitle.slice(0, 120) : fileTitle;
    return { title, chapters, words: countWords(text) };
  }

  return parseEpub(buffer);
}

/** Everything a chapter needs to be narrated, in reading order. */
export function bookToScript(book: ParsedBook, chapterIndexes?: number[]): string {
  const chapters =
    chapterIndexes && chapterIndexes.length > 0
      ? chapterIndexes.map((index) => book.chapters[index]).filter(Boolean)
      : book.chapters;

  return chapters
    .map((chapter, index) => {
      // Most chapters already open with their own heading; only add a title
      // when the body text does not carry it.
      const needsTitle = index > 0 && !chapter.text.startsWith(chapter.title);
      return needsTitle ? `${chapter.title}\n\n${chapter.text}` : chapter.text;
    })
    .join('\n\n');
}
