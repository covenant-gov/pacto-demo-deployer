import { invokeTauri, withMcp } from '../lib/mcp.mjs';
import { isAlive, log, writePidsFile } from '../lib/process.mjs';
import {
  demoLeadAndOthers,
  lastOutboundMessageId,
  loadLiveSession,
  namedClients,
} from '../lib/session.mjs';

export async function run(ctx) {
  const clients = ctx.clients ?? [];
  const named = namedClients(clients).filter(c => isAlive(c.pid));
  if (named.length < 2) {
    log('dm: need at least 2 named clients');
    return;
  }
  const { first, others } = demoLeadAndOthers(named);

  log('demo 1 DMs other clients');
  const outboundIds = new Map();
  await withMcp(first.ports.mcpBridge, async bridge => {
    for (const peer of others) {
      const content = `hello from ${first.name}`;
      try {
        await invokeTauri(bridge, 'message', {
          receiver: peer.npub,
          content,
          repliedTo: '',
          file: null,
          virtualBucket: null,
        });
        const id = await lastOutboundMessageId(bridge, peer.npub, content);
        if (id) outboundIds.set(peer.index, id);
        log(`  ${first.name} -> ${peer.name}${id ? ` (${id.slice(0, 12)}…)` : ''}`);
      } catch (err) {
        log(`  ${first.name} -> ${peer.name} failed: ${err.message}`);
      }
    }
  });

  log('other clients reply to demo 1');
  for (const peer of others) {
    const content = `hello from ${peer.name}`;
    const repliedTo = outboundIds.get(peer.index) || '';
    try {
      await withMcp(peer.ports.mcpBridge, async bridge => {
        await invokeTauri(bridge, 'message', {
          receiver: first.npub,
          content,
          repliedTo,
          file: null,
          virtualBucket: null,
        });
      });
      log(`  ${peer.name} -> ${first.name}${repliedTo ? ' (reply)' : ''}`);
    } catch (err) {
      log(`  ${peer.name} -> ${first.name} failed: ${err.message}`);
    }
  }
}

export async function cmdDm(args) {
  const { state, clients } = await loadLiveSession(args);
  await run({ clients });
  writePidsFile(state);
}
