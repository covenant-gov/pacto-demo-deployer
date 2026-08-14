import { CANCEL_BROADCAST_MS } from '../lib/config.mjs';
import { invokeTauri, withMcp } from '../lib/mcp.mjs';
import { isAlive, log } from '../lib/process.mjs';
import { namedClients, reloadWebview } from '../lib/session.mjs';

async function publishDemoBroadcast(bridge, npub, name) {
  try {
    const active = await invokeTauri(bridge, 'commons_get_local_active', {
      subject: 'user',
      subjectId: npub,
    });
    if (active) {
      await invokeTauri(bridge, 'commons_cancel_broadcast', {
        subject: 'user',
        subjectId: npub,
      });
    }
  } catch {
    // nothing active
  }
  await invokeTauri(bridge, 'commons_publish_broadcast', {
    input: {
      subject: 'user',
      message: name,
      durationHours: 24,
      tags: ['test'],
      audience: 'new_user',
    },
  });
}

export async function cancelDemoBroadcast(client, { quiet = false } = {}) {
  if (!client?.npub || !isAlive(client.pid)) return;
  try {
    await withMcp(client.ports.mcpBridge, async bridge => {
      await invokeTauri(
        bridge,
        'commons_cancel_broadcast',
        { subject: 'user', subjectId: client.npub },
        CANCEL_BROADCAST_MS,
      );
    });
    if (!quiet) log(`client ${client.index}: cancelled broadcast`);
  } catch (err) {
    if (!quiet) log(`client ${client.index}: cancel broadcast failed: ${err.message}`);
  }
}

export async function run(ctx) {
  const clients = ctx.clients ?? [];
  const pin = ctx.pin;
  const named = namedClients(clients);
  if (named.length === 0) {
    log('broadcast: no named clients, skipping');
    return;
  }
  log('Commons broadcasts');
  for (const client of named) {
    try {
      await withMcp(client.ports.mcpBridge, async bridge => {
        await publishDemoBroadcast(bridge, client.npub, client.name);
        await reloadWebview(bridge, pin);
      });
      client.broadcast = true;
      log(`  client ${client.index}: broadcast ${client.name}`);
    } catch (err) {
      log(`  client ${client.index}: broadcast failed: ${err.message}`);
    }
  }
}
