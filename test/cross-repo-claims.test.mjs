import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimForClient, claimPathForIndex, readClaimRecord } from '../src/lib/claims.mjs';

// Proves this repo's claim writer and pacto-app's real resolver agree on the
// wire format: a claim we write here must make pacto-app's own
// resolvePortSet() skip past our index instead of colliding with it.
// Read-only against pacto-app -- never imports anything but the exported
// pure functions of dev-ports.mjs.
const PACTO_APP_DEV_PORTS =
  process.env.PACTO_APP_DEV_PORTS || '/Users/opselite/src/covenant-gov/pacto-app/scripts/dev-ports.mjs';
const available = fs.existsSync(PACTO_APP_DEV_PORTS);

test(
  "pacto-app's resolvePortSet yields to a live claim written by this repo",
  {
    skip: available
      ? false
      : `pacto-app checkout not found at ${PACTO_APP_DEV_PORTS} ` +
        '(set PACTO_APP_DEV_PORTS to override)',
  },
  async () => {
    const { resolvePortSet, deriveIndex } = await import(pathToFileURL(PACTO_APP_DEV_PORTS).href);

    const claimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-repo-claim-'));
    try {
      const CLIENT_INDEX = 1;
      const ourPid = process.pid;
      claimForClient(CLIENT_INDEX, ourPid, { claimDir });

      // Find a pacto-app branch name that derives to the exact index we
      // just claimed, so resolvePortSet actually has to contend with it
      // instead of starting somewhere else entirely.
      let branch = null;
      for (let n = 0; n < 5000; n++) {
        const candidate = `demo-deployer-cross-repo-test-${n}`;
        if (deriveIndex(candidate) === CLIENT_INDEX) {
          branch = candidate;
          break;
        }
      }
      assert.ok(branch, `could not find a branch name deriving to index ${CLIENT_INDEX}`);

      const resolved = await resolvePortSet({
        branch,
        probe: true,
        claimDir,
        claimGraceMs: 180_000,
      });

      console.log(
        `cross-repo proof: branch=${branch} derivedIndex=${CLIENT_INDEX} -> ` +
          `resolvePortSet returned ${JSON.stringify(resolved)}`,
      );

      assert.strictEqual(resolved.derivedIndex, CLIENT_INDEX);
      assert.notStrictEqual(
        resolved.index,
        CLIENT_INDEX,
        `pacto-app should have advanced away from index ${CLIENT_INDEX}, got ${JSON.stringify(resolved)}`,
      );
      assert.strictEqual(resolved.advanced, true);

      // Our claim must be untouched: pacto-app must not clobber a live
      // foreign claim just because it decided to advance past it.
      const ours = readClaimRecord(claimPathForIndex(CLIENT_INDEX, claimDir));
      assert.strictEqual(ours.branch, 'io.pacto.demo.1');
      assert.strictEqual(ours.pid, ourPid);
    } finally {
      fs.rmSync(claimDir, { recursive: true, force: true });
    }
  },
);
