// Tests for the pre-upload release guard. Each failure case is one that shipped
// or nearly shipped: 0.3.4's spaced name, a sidecar naming the wrong file, and a
// stale hash.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseAssets } from './verify-release-assets.mjs';

const version = '0.3.6';
const installer = `Denspeak.Studio.Setup.${version}.exe`;
const bytes = Buffer.from('installer payload');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const dirs = [];
async function fixture({ installerName = installer, sidecarName = installer, line } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'denspeak-release-'));
  dirs.push(dir);
  await writeFile(join(dir, installerName), bytes);
  await writeFile(join(dir, `${installerName}.sha256`), `${line ?? `${sha256(bytes)}  ${sidecarName}`}\n`);
  return dir;
}

// A throwaway project root: the script reads ../package.json and ../release/
// from its own location, so the CLI can be run from a copy without touching
// this repository's build output.
async function cliRoot() {
  const root = await mkdtemp(join(tmpdir(), 'denspeak-cli-'));
  dirs.push(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'release'));
  await copyFile(new URL('./verify-release-assets.mjs', import.meta.url), join(root, 'scripts', 'verify-release-assets.mjs'));
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ version })}\n`);
  await writeFile(join(root, 'release', installer), bytes);
  await writeFile(join(root, 'release', `${installer}.sha256`), `${sha256(bytes)}  ${installer}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('verifyReleaseAssets', () => {
  it('accepts a pair whose checksum names the installer being uploaded', async () => {
    const dir = await fixture();

    await expect(verifyReleaseAssets({ releaseDir: dir, version })).resolves.toBe(installer);
  });

  it('rejects a name GitHub would rewrite from spaces to dots', async () => {
    const spaced = `Denspeak Studio Setup ${version}.exe`;
    const dir = await fixture({ installerName: spaced, sidecarName: spaced });

    await expect(verifyReleaseAssets({ releaseDir: dir, version })).rejects.toThrow(/would be published as/);
  });

  it('rejects a checksum line naming a different file', async () => {
    const dir = await fixture({ sidecarName: `Denspeak.Studio.Setup.0.3.5.exe` });

    await expect(verifyReleaseAssets({ releaseDir: dir, version })).rejects.toThrow(
      /names "Denspeak\.Studio\.Setup\.0\.3\.5\.exe" but the file being uploaded is/,
    );
  });

  it('rejects a hash that does not match the installer', async () => {
    const dir = await fixture({ line: `${sha256(Buffer.from('some other build'))}  ${installer}` });

    await expect(verifyReleaseAssets({ releaseDir: dir, version })).rejects.toThrow(/does not match/);
  });

  it('runs the check when invoked as a script', async () => {
    const root = await cliRoot();

    const result = spawnSync(process.execPath, ['scripts/verify-release-assets.mjs'], { cwd: root, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^release-check: Denspeak\.Studio\.Setup\.0\.3\.6\.exe is named as published and matches /m);
  });
});
