// Fails a release before upload if the .sha256 sidecar would not verify against
// the published installer. GitHub rewrites spaces in asset names to dots, so a
// checksum line naming an on-disk name with spaces points at a file nobody can
// download (that is how 0.3.4 shipped a broken sidecar).
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => {
  throw new Error(`release-check: ${message}`);
};

const pathOf = (dir) => (typeof dir === 'string' ? dir : fileURLToPath(dir));

// Throws (with a "release-check: " message) when the pair would not verify, and
// returns the installer name when it would.
export async function verifyReleaseAssets({ releaseDir, version }) {
  const dir = pathOf(releaseDir);

  const installers = (await readdir(dir)).filter(
    (name) => /\.exe$/i.test(name) && name.toLowerCase().endsWith(`${version}.exe`),
  );
  if (installers.length !== 1) {
    fail(`expected exactly one ${version} installer in release/, found ${installers.length}${installers.length ? `: ${installers.join(', ')}` : ''}`);
  }
  const installer = installers[0];

  // The name must survive upload unchanged or the sidecar names a missing file.
  const published = installer.replace(/ /g, '.');
  if (published !== installer) {
    fail(`"${installer}" would be published as "${published}", so its checksum line would name a file that does not exist`);
  }
  const expected = `Denspeak.Studio.Setup.${version}.exe`;
  if (installer !== expected) {
    fail(`installer is "${installer}", expected "${expected}" - check build.artifactName in package.json`);
  }

  const sidecar = `${installer}.sha256`;
  const line = (await readFile(join(dir, sidecar), 'utf8').catch(() => fail(`missing ${sidecar}`))).trim();
  // sha256sum allows a leading * for binary mode; the name may itself contain spaces.
  const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line);
  if (!match) fail(`${sidecar} is not in "sha256  file" form: ${JSON.stringify(line)}`);
  const [, hash, name] = match;
  if (name !== installer) fail(`${sidecar} names "${name}" but the file being uploaded is "${installer}"`);

  const actual = createHash('sha256').update(await readFile(join(dir, installer))).digest('hex');
  if (hash.toLowerCase() !== actual) fail(`${sidecar} hash ${hash} does not match ${installer} (${actual})`);

  return installer;
}

// Run the check only when this file is the entry point; importing it is inert.
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
const invokedDirectly =
  entry !== '' && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self);

if (invokedDirectly) {
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const releaseDir = fileURLToPath(new URL('../release/', import.meta.url));
  try {
    const installer = await verifyReleaseAssets({ releaseDir, version });
    console.log(`release-check: ${installer} is named as published and matches ${installer}.sha256.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
