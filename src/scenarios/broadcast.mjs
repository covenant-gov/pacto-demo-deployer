import { CANCEL_BROADCAST_MS, formatDemoStamp } from '../lib/config.mjs';
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
      message: `${name} · ${formatDemoStamp()}`,
      durationHours: 24,
      tags: ['test'],
      audience: 'new_user',
    },
  });
}

function isExpectedSquadCancelMiss(message) {
  const text = String(message || '');
  return (
    text.includes('Squad bot not initialized') ||
    text.includes('Only bot key holders') ||
    text.includes('Local bot secret is stale')
  );
}

async function listCatalogSquads(bridge) {
  try {
    const rows = await invokeTauri(bridge, 'list_squads');
    return (Array.isArray(rows) ? rows : []).filter(row => row?.id);
  } catch {
    return [];
  }
}

async function cancelSubjectBroadcast(bridge, subject, subjectId) {
  await invokeTauri(
    bridge,
    'commons_cancel_broadcast',
    { subject, subjectId },
    CANCEL_BROADCAST_MS,
  );
}

export async function cancelDemoBroadcast(client, { quiet = false } = {}) {
  if (!client?.ports?.mcpBridge || !isAlive(client.pid)) return;
  try {
    await withMcp(client.ports.mcpBridge, async bridge => {
      if (client.npub) {
        try {
          await cancelSubjectBroadcast(bridge, 'user', client.npub);
        } catch (err) {
          if (!quiet) log(`client ${client.index}: cancel user broadcast failed: ${err.message}`);
        }
      }
      for (const squad of await listCatalogSquads(bridge)) {
        try {
          await cancelSubjectBroadcast(bridge, 'squad', squad.id);
        } catch (err) {
          if (!quiet && !isExpectedSquadCancelMiss(err.message)) {
            log(`client ${client.index}: cancel squad broadcast failed: ${err.message}`);
          }
        }
      }
    });
    if (!quiet) log(`client ${client.index}: cancelled broadcasts`);
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
