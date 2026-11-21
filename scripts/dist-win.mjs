// Windows installer build. Signs with Azure Trusted Signing when
// build.win.azureSignOptions is configured in package.json (endpoint, account,
// profile, and publisher are identifiers, not secrets, and are safe to
// commit). Entra auth (AZURE_TENANT_ID / AZURE_CLIENT_ID /
// AZURE_CLIENT_SECRET) comes from the environment; electron-builder fails the
// build if it is missing. Unsigned otherwise. Never publishes.
import { readFile } from 'node:fs/promises';
import { build, Platform } from 'electron-builder';

const { build: base } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const signed = Boolean(base.win?.azureSignOptions);
console.log(`dist-win: ${signed ? 'signing with Azure Trusted Signing' : 'no signing configured — building unsigned'}.`);

await build({
  targets: Platform.WINDOWS.createTarget(),
  config: base,
  publish: 'never',
});
