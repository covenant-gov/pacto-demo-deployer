import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASE_DEV_SERVER,
  BASE_HMR,
  BASE_MCP_BRIDGE,
  BRIDGE_STRIDE,
  DEPLOYER_DIR,
  PORT_STRIDE,
  UNSAFE_BROWSER_PORTS,
} from '../src/lib/config.mjs';

// UNSAFE_BROWSER_PORTS here is a hand-copy of pacto-app's list in
// scripts/dev-ports.mjs. Nothing enforces they stay identical except this
// test, which only runs once .cache/pacto-app exists (after a real `up`) --
// it must never become a dependency of launching itself.
const CACHED_DEV_PORTS = path.join(DEPLOYER_DIR, '.cache', 'pacto-app', 'scripts', 'dev-ports.mjs');
const available = fs.existsSync(CACHED_DEV_PORTS);

// pacto-app's UNSAFE_BROWSER_PORTS is a module-private const, not exported --
// pull the literal out of the source text instead of only probing it
// indirectly through derived indices (probing misses any entry that isn't a
// port some index 1..31 actually derives, e.g. a typo'd or stray value).
function parseUnsafePortsLiteral(source) {
  const match = source.match(/const UNSAFE_BROWSER_PORTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'could not find UNSAFE_BROWSER_PORTS literal in pacto-app source');
  return new Set((match[1].match(/\d+/g) || []).map(Number));
}

function setDiff(a, b) {
  return [...a].filter(x => !b.has(x));
}

test(
  'UNSAFE_BROWSER_PORTS agrees with the cached pacto-app clone',
  {
    skip: available
      ? false
      : `no .cache/pacto-app clone at ${CACHED_DEV_PORTS} yet (run 'up' once to populate it)`,
  },
  async () => {
    const theirs = parseUnsafePortsLiteral(fs.readFileSync(CACHED_DEV_PORTS, 'utf8'));

    const onlyOurs = setDiff(UNSAFE_BROWSER_PORTS, theirs);
    const onlyTheirs = setDiff(theirs, UNSAFE_BROWSER_PORTS);
    assert.deepStrictEqual(
      { onlyOurs, onlyTheirs },
      { onlyOurs: [], onlyTheirs: [] },
      'UNSAFE_BROWSER_PORTS drifted from pacto-app scripts/dev-ports.mjs',
    );

    // Secondary check: the two lists also have to agree on every index this
    // repo can actually launch (1..31, matching pacto-app's MAX_INDEX).
    const { browserSafeIndex } = await import(pathToFileURL(CACHED_DEV_PORTS).href);
    for (let index = 1; index <= 31; index++) {
      const ports = {
        devServer: BASE_DEV_SERVER + index * PORT_STRIDE,
        hmr: BASE_HMR + index * PORT_STRIDE,
        mcpBridge: BASE_MCP_BRIDGE + index * BRIDGE_STRIDE,
      };
      const oursSafe =
        !UNSAFE_BROWSER_PORTS.has(ports.devServer) &&
        !UNSAFE_BROWSER_PORTS.has(ports.hmr) &&
        !UNSAFE_BROWSER_PORTS.has(ports.mcpBridge);
      assert.strictEqual(oursSafe, browserSafeIndex(index), `index ${index} browser-safety disagreement`);
    }
  },
);
