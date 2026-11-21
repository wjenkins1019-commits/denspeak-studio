// Writes the release body and the installer's .sha256 sidecar from what the
// build actually produced, so a tag release never needs its notes or checksum
// fixed by hand afterwards. Run after `npm run dist:win`, with the tag checked
// out and full history (fetch-depth: 0) so the previous tag is available.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const releaseDir = new URL('../release/', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: rootPath, encoding: 'utf8' }).trim();

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.GITHUB_REF_NAME || `v${version}`;

// Previous release tag, for the "what changed" range and the compare link.
let previous = null;
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`) || null;
} catch {
  previous = null;
}

// Commit subjects between releases are the changelog. Version bumps are bookkeeping.
const range = previous ? `${previous}..${tag}` : tag;
const subjects = git('log', '--no-merges', '--pretty=format:%s', range)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !/^bump version to /i.test(line));
if (subjects.length === 0) subjects.push('No user-visible changes; maintenance build only.');
const bullets = subjects.reverse().map((subject) => `- ${subject}`).join('\n');
const changedHeading = previous ? `**What changed since ${previous}**` : '**What changed**';

// Match the installer by the version in package.json: electron-builder's own
// naming (spaces or dots) stays whatever the build decided, and stale local
// artifacts from other versions are ignored.
const installers = (await readdir(releaseDir)).filter((name) => /\.exe$/i.test(name));
const installer = installers.find((name) => name.toLowerCase().endsWith(`${version}.exe`));
if (!installer) {
  console.error(`No ${version} installer in release/ (found: ${installers.join(', ') || 'none'}).`);
  process.exit(1);
}

const bytes = await readFile(new URL(installer, releaseDir));
const digest = createHash('sha256').update(bytes).digest('hex');
const sidecar = `${installer}.sha256`;
// `sha256sum -c` format: hash, two spaces, file name.
await writeFile(new URL(sidecar, releaseDir), `${digest}  ${installer}\n`);

let slug = process.env.GITHUB_REPOSITORY || '';
if (!slug) {
  try {
    slug = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^.*github\.com[/:]/, '');
  } catch {
    slug = '';
  }
}
const compareLink =
  previous && slug
    ? `\n\n**Full Changelog**: https://github.com/${slug}/compare/${previous}...${tag}`
    : '';

const notes = `Windows installer for Denspeak Studio ${version} - on-device voice studio (121 Piper voices, no account, no upload, no API key).

${changedHeading}

${bullets}

**Download:** \`${installer}\` below (Windows 10/11 x64, ~${Math.round(bytes.length / 1024 / 1024)} MB). The build is unsigned, so SmartScreen may ask for confirmation. \`${sidecar}\` sits beside it: run \`sha256sum -c ${sidecar}\` next to the downloaded pair, or compare it with the digest GitHub shows on the asset.

**First run:** voices download on first use (20-60 MB each) and are cached, so later renders work offline. A microphone is only needed for Convert/Transcribe.

**From source:** requires Node.js 20+ - \`npm install && npm run dev\`. The installer below is the build that passed this run's typecheck and test steps.${compareLink}
`;

await writeFile(new URL('../release-notes.md', import.meta.url), notes);

console.log(`release-notes: ${installer} sha256:${digest}`);
console.log(`release-notes: ${subjects.length} change(s) since ${previous ?? 'the first release'}`);
