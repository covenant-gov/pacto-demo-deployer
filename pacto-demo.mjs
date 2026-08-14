#!/usr/bin/env node
/**
 * Multi-client Pacto demo deployer.
 *
 * Standalone launcher: clones covenant-gov/pacto-app, checks out a GitHub
 * branch or PR into a detached worktree, then launches N isolated `tauri dev`
 * clients with unique io.pacto.demo.<n> identifiers. Never uses or deletes
 * io.pacto (the main client).
 */

import { usageText } from './src/lib/config.mjs';
import { fail, log } from './src/lib/process.mjs';
import { cmdUp } from './src/commands/up.mjs';
import { cmdDown, cmdStatus, cmdWipe } from './src/commands/lifecycle.mjs';
import { cmdDm, cmdSquad } from './src/scenarios/index.mjs';

const USAGE = usageText();

function parseArgs(argv) {
  const out = {
    command: 'help',
    pr: null,
    branch: null,
    clients: null,
    envFile: null,
    seeds: [],
    pin: null,
    client: null,
    all: false,
    wipe: false,
    full: false,
    join: false,
    name: null,
  };
  const rest = argv.slice(2);
  if (rest.length === 0) return out;

  const first = rest[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    out.command = 'help';
    return out;
  }
  out.command = first;

  const take = (flag, i, args) => {
    const value = args[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--pr':
        out.pr = take(arg, i, rest);
        i += 1;
        break;
      case '--branch':
        out.branch = take(arg, i, rest);
        i += 1;
        break;
      case '--clients':
        out.clients = take(arg, i, rest);
        i += 1;
        break;
      case '--env':
        out.envFile = take(arg, i, rest);
        i += 1;
        break;
      case '--seed':
        out.seeds.push(take(arg, i, rest));
        i += 1;
        break;
      case '--pin':
        out.pin = take(arg, i, rest);
        i += 1;
        break;
      case '--client':
        out.client = take(arg, i, rest);
        i += 1;
        break;
      case '--name':
        out.name = take(arg, i, rest);
        i += 1;
        break;
      case '--all':
        out.all = true;
        break;
      case '--join':
        out.join = true;
        break;
      case '--full':
        out.full = true;
        break;
      case '--wipe':
        out.wipe = true;
        break;
      case '-h':
      case '--help':
        out.command = 'help';
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error('');
    console.error(USAGE);
    process.exit(1);
  }

  try {
    switch (args.command) {
      case 'help':
        log(USAGE);
        break;
      case 'up':
      case 'up-full':
      case 'reload':
        await cmdUp(args, { full: args.command === 'up-full' || args.full });
        break;
      case 'dm':
        await cmdDm(args);
        break;
      case 'squad':
        await cmdSquad(args);
        break;
      case 'down':
        await cmdDown({ wipe: args.wipe });
        break;
      case 'status':
        cmdStatus();
        break;
      case 'wipe':
        cmdWipe(args);
        break;
      default:
        throw new Error(`unknown command '${args.command}'`);
    }
  } catch (err) {
    fail(err.message);
  }
}

await main();
