import * as broadcast from './broadcast.mjs';
import * as dm from './dm.mjs';
import * as squad from './squad.mjs';

export const scenarios = {
  broadcast: {
    id: 'broadcast',
    description: 'Commons user broadcast',
    run: broadcast.run,
  },
  dm: {
    id: 'dm',
    description: 'alpha DMs others; they reply',
    run: dm.run,
  },
  squad: {
    id: 'squad',
    description: 'create announcements MLS, invite, accept',
    run: squad.run,
    join: squad.joinExisting,
  },
};

export async function runScenario(id, ctx, opts = {}) {
  const scenario = scenarios[id];
  if (!scenario) throw new Error(`unknown scenario '${id}'`);
  if (opts.join && typeof scenario.join === 'function') {
    return scenario.join(ctx, opts);
  }
  return scenario.run(ctx, opts);
}

export { cmdDm } from './dm.mjs';
export { cmdSquad } from './squad.mjs';
export { cancelDemoBroadcast } from './broadcast.mjs';
