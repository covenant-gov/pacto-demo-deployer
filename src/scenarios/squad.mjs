import {
  DEMO_SQUAD_NAME_PREFIX,
  DEMO_SQUAD_NETWORK,
  DEMO_SQUAD_TAGS,
  SQUAD_ACCEPT_UI_WAIT_MS,
  SQUAD_KEYPACKAGE_WAIT_MS,
  SQUAD_RETRY_MS,
  SQUAD_WELCOME_WAIT_MS,
  formatDemoStamp,
} from '../lib/config.mjs';
import { executeJs, invokeTauri, waitForTauri, withMcp } from '../lib/mcp.mjs';
import { isAlive, log, sleep, writePidsFile } from '../lib/process.mjs';
import {
  demoLeadAndOthers,
  loadLiveSession,
  namedClients,
  reloadWebview,
} from '../lib/session.mjs';

async function listSquadNames(bridge) {
  try {
    const rows = await invokeTauri(bridge, 'list_squads');
    return (Array.isArray(rows) ? rows : []).map(s => s?.name).filter(Boolean);
  } catch {
    return [];
  }
}

function nextNumberedSquadName(existingNames, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}-([1-9][0-9]*)$`);
  let max = 0;
  for (const name of existingNames) {
    if (name === prefix) max = Math.max(max, 0);
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

async function resolveSquadName(bridge, requested) {
  const custom = requested && String(requested).trim();
  if (custom) return custom;
  const names = await listSquadNames(bridge);
  return nextNumberedSquadName(names, DEMO_SQUAD_NAME_PREFIX);
}

async function saveSquadNetworkSepolia(bridge, npub, groupId) {
  const script = `(() => {
    const key = ${JSON.stringify(`pacto_squad_network_v1_${npub}`)};
    const groupId = ${JSON.stringify(groupId)};
    let blob = { v: 1, byParentId: {} };
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      if (parsed && parsed.v === 1 && parsed.byParentId && typeof parsed.byParentId === 'object') {
        blob = parsed;
      }
    } catch {}
    blob.v = 1;
    blob.byParentId = blob.byParentId || {};
    blob.byParentId[groupId] = ${JSON.stringify(DEMO_SQUAD_NETWORK)};
    localStorage.setItem(key, JSON.stringify(blob));
    return true;
  })()`;
  await executeJs(bridge, script);
}

function sameMlsGroupId(a, b) {
  const norm = value => String(value || '').trim().toLowerCase().replace(/^0x/, '');
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}

function welcomeGroupId(row) {
  return row?.nostr_group_id || row?.nostrGroupId || '';
}

async function refreshContactKeypackages(bridge, npub) {
  const devices = await invokeTauri(bridge, 'refresh_keypackages_for_contact', { npub });
  return Array.isArray(devices) ? devices : [];
}

async function waitForInviteeKeypackages(bridge, npub, timeoutMs = SQUAD_KEYPACKAGE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const devices = await refreshContactKeypackages(bridge, npub);
      if (devices.length > 0) return devices;
    } catch (err) {
      lastErr = err;
    }
    await sleep(2_000);
  }
  const detail = lastErr ? `: ${lastErr.message}` : '';
  throw new Error(`no keypackages for invitee${detail}`);
}

async function publishFreshKeypackage(client) {
  await withMcp(client.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    await invokeTauri(bridge, 'regenerate_device_keypackage', { cache: false });
  });
}

async function ensureInviteeKeypackages(creator, invitee) {
  const ready = await withMcp(creator.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    try {
      await waitForInviteeKeypackages(bridge, invitee.npub);
      return true;
    } catch {
      return false;
    }
  });
  if (ready) return;
  log(`  ${invitee.name}: publishing device keypackage`);
  await publishFreshKeypackage(invitee);
  await withMcp(creator.ports.mcpBridge, async bridge => {
    await waitForInviteeKeypackages(bridge, invitee.npub);
  });
}

function squadCatalogPayload(groupId, squadName, now) {
  return {
    id: groupId,
    name: squadName,
    iconUrl: null,
    channels: [
      { name: 'announcements', groupId, order: 0 },
      { name: 'polls', groupId, order: 1 },
    ],
    kind: 'squad',
    pairedSquads: null,
    visibility: 'public',
    commonsTags: DEMO_SQUAD_TAGS,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

async function listMlsGroupIds(bridge) {
  try {
    const ids = await invokeTauri(bridge, 'list_mls_groups');
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

async function findPendingWelcome(bridge, groupId) {
  const list = await invokeTauri(bridge, 'list_pending_mls_welcomes');
  const rows = Array.isArray(list) ? list : [];
  return rows.find(row => sameMlsGroupId(welcomeGroupId(row), groupId)) || (rows.length === 1 ? rows[0] : null);
}

async function waitForPendingWelcome(bridge, groupId, timeoutMs = SQUAD_WELCOME_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await invokeTauri(bridge, 'sync_mls_groups_now', { groupId: null });
    } catch {
      // invitee may not be in the group yet; listing welcomes is enough
    }
    const welcome = await findPendingWelcome(bridge, groupId);
    if (welcome) return welcome;
    const groups = await listMlsGroupIds(bridge);
    if (groups.some(id => sameMlsGroupId(id, groupId))) return 'already_member';
    await sleep(1_500);
  }
  return null;
}

async function persistInviteeSquad(bridge, invitee, groupId, squadName, now) {
  await invokeTauri(bridge, 'upsert_squad', {
    squad: squadCatalogPayload(groupId, squadName, now),
  });
  try {
    await saveSquadNetworkSepolia(bridge, invitee.npub, groupId);
  } catch (err) {
    log(`  ${invitee.name}: sepolia network save failed: ${err.message}`);
  }
}

async function tryClickSquadInviteAccept(bridge, squadName) {
  try {
    return await executeJs(
      bridge,
      `(() => {
        const name = ${JSON.stringify(squadName)};
        const cards = [...document.querySelectorAll('.invite-card')];
        const card = cards.find((c) => c.querySelector('.invite-card-title')?.textContent?.trim() === name) || cards[0];
        const btn = card?.querySelector('.invite-card-btn-accept');
        if (!btn || btn.disabled) return { clicked: false };
        btn.click();
        return { clicked: true };
      })()`,
    );
  } catch {
    return { clicked: false };
  }
}

async function waitForInviteAccepted(bridge, groupId, timeoutMs = SQUAD_ACCEPT_UI_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groups = await listMlsGroupIds(bridge);
    if (groups.some(id => sameMlsGroupId(id, groupId))) return true;
    const welcome = await findPendingWelcome(bridge, groupId);
    if (!welcome) {
      const again = await listMlsGroupIds(bridge);
      if (again.some(id => sameMlsGroupId(id, groupId))) return true;
    }
    await sleep(800);
  }
  return false;
}

async function reinviteMember(creator, invitee, groupId) {
  log(`  ${invitee.name}: no pending welcome; republish keypackage and re-invite`);
  await publishFreshKeypackage(invitee);
  await withMcp(creator.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    await waitForInviteeKeypackages(bridge, invitee.npub);
    await invokeTauri(bridge, 'invite_member_to_group', {
      groupId,
      memberNpub: invitee.npub,
    });
  });
}

async function acceptSquadInviteOnClient(invitee, groupId, squadName, now, { creator } = {}) {
  await withMcp(invitee.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    let welcome = await waitForPendingWelcome(bridge, groupId);
    if (welcome === 'already_member') {
      await persistInviteeSquad(bridge, invitee, groupId, squadName, now);
      log(`  ${invitee.name}: already in MLS group`);
      return;
    }
    if (!welcome && creator) {
      await reinviteMember(creator, invitee, groupId);
      welcome = await waitForPendingWelcome(bridge, groupId);
    }
    if (welcome === 'already_member') {
      await persistInviteeSquad(bridge, invitee, groupId, squadName, now);
      log(`  ${invitee.name}: already in MLS group`);
      return;
    }
    if (!welcome) {
      throw new Error('no pending MLS welcome');
    }
    const clicked = await tryClickSquadInviteAccept(bridge, squadName);
    if (clicked?.clicked) {
      log(`  ${invitee.name}: Accept`);
      if (await waitForInviteAccepted(bridge, groupId)) {
        await persistInviteeSquad(bridge, invitee, groupId, squadName, now);
        return;
      }
    }
    const stillPending = await findPendingWelcome(bridge, groupId);
    if (stillPending) {
      const ok = await invokeTauri(bridge, 'accept_mls_welcome', {
        welcomeEventIdHex: stillPending.id,
      });
      if (ok === false) throw new Error('accept_mls_welcome returned false');
      log(`  ${invitee.name}: accepted MLS welcome`);
    } else {
      const groups = await listMlsGroupIds(bridge);
      if (!groups.some(id => sameMlsGroupId(id, groupId))) {
        throw new Error('welcome disappeared before join completed');
      }
      log(`  ${invitee.name}: joined via Accept`);
    }
    await persistInviteeSquad(bridge, invitee, groupId, squadName, now);
  });
}

export async function run(ctx, opts = {}) {
  const clients = ctx.clients ?? [];
  const pin = ctx.pin;
  const all = Boolean(opts.all);
  const name = opts.name ?? null;
  const named = namedClients(clients).filter(c => isAlive(c.pid));
  if (named.length < 2) {
    log('squad: need at least 2 named clients');
    return;
  }
  const { first, others } = demoLeadAndOthers(named);
  const second = named.find(c => c.index === 2) || others[0];
  const invitees = all ? others : [second];
  const memberIds = invitees.map(c => c.npub);

  const members = [first, ...invitees];
  const squadName = await withMcp(first.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    return resolveSquadName(bridge, name);
  });
  log(
    `squad: ${first.name} creates ${squadName} on ${DEMO_SQUAD_NETWORK}, invites ${invitees.map(c => c.name).join(', ')}`,
  );
  for (const peer of invitees) {
    try {
      await ensureInviteeKeypackages(first, peer);
    } catch (err) {
      log(`  ${peer.name}: keypackage not ready: ${err.message}`);
    }
  }

  const deadline = Date.now() + SQUAD_RETRY_MS;
  let lastErr = null;
  let groupId = null;
  while (Date.now() < deadline) {
    try {
      groupId = await withMcp(first.ports.mcpBridge, async bridge => {
        return invokeTauri(bridge, 'create_group_chat', {
          groupName: 'announcements',
          memberIds,
        });
      });
      break;
    } catch (err) {
      lastErr = err;
      log(`  squad create retry: ${err.message}`);
      await sleep(2_000);
    }
  }
  if (!groupId) {
    log(`  squad create failed: ${lastErr?.message || 'unknown error'}`);
    return;
  }
  log(`  MLS announcements ${typeof groupId === 'string' ? groupId.slice(0, 16) : groupId}…`);

  const now = Date.now();
  await withMcp(first.ports.mcpBridge, async bridge => {
    await invokeTauri(bridge, 'upsert_squad', {
      squad: squadCatalogPayload(groupId, squadName, now),
    });
    try {
      await invokeTauri(bridge, 'squad_bot_init', { squadId: groupId });
    } catch (err) {
      log(`  squad bot init failed: ${err.message}`);
    }
    try {
      await saveSquadNetworkSepolia(bridge, first.npub, groupId);
    } catch (err) {
      log(`  sepolia network save failed: ${err.message}`);
    }
    const inviteBody = JSON.stringify({
      type: 'squad_invite',
      squadName,
      groupId,
      kind: 'squad',
      invitedByNpub: first.npub,
    });
    for (const peer of invitees) {
      try {
        await invokeTauri(bridge, 'message', {
          receiver: peer.npub,
          content: inviteBody,
          repliedTo: '',
          file: null,
          virtualBucket: null,
        });
        log(`  invite DM -> ${peer.name}`);
      } catch (err) {
        log(`  invite DM -> ${peer.name} failed: ${err.message}`);
      }
    }
    try {
      await invokeTauri(bridge, 'commons_publish_broadcast', {
        input: {
          subject: 'squad',
          message: `New squad: ${squadName} · ${formatDemoStamp()}`,
          durationHours: 72,
          tags: [...DEMO_SQUAD_TAGS, 'new'],
          squad: {
            id: groupId,
            name: squadName,
            kind: 'squad',
            iconUrl: null,
          },
        },
      });
      log(`  Commons broadcast #${DEMO_SQUAD_TAGS[0]}`);
    } catch (err) {
      log(`  Commons broadcast failed: ${err.message}`);
    }
  });

  for (const peer of invitees) {
    try {
      await acceptSquadInviteOnClient(peer, groupId, squadName, now, { creator: first });
    } catch (err) {
      log(`  ${peer.name}: accept failed: ${err.message}`);
    }
  }

  for (const client of members) {
    try {
      await withMcp(client.ports.mcpBridge, async bridge => {
        await reloadWebview(bridge, pin);
      });
    } catch (err) {
      log(`  client ${client.index}: reload failed: ${err.message}`);
    }
  }
}

export async function joinExisting(ctx, opts = {}) {
  const clients = ctx.clients ?? [];
  const pin = ctx.pin;
  const all = Boolean(opts.all);
  const name = opts.name ?? null;
  const named = namedClients(clients).filter(c => isAlive(c.pid));
  if (named.length < 2) {
    log('squad: need at least 2 named clients');
    return;
  }
  const { first, others } = demoLeadAndOthers(named);
  const second = named.find(c => c.index === 2) || others[0];
  const invitees = all ? others : [second];
  const rows = await withMcp(first.ports.mcpBridge, async bridge => {
    await waitForTauri(bridge);
    return invokeTauri(bridge, 'list_squads');
  });
  const list = Array.isArray(rows) ? rows : [];
  const wanted = name && String(name).trim();
  const squad = wanted
    ? list.find(row => row?.name === wanted)
    : [...list].sort((a, b) => Number(b?.createdAtMs || 0) - Number(a?.createdAtMs || 0))[0];
  if (!squad?.id) {
    log(wanted ? `squad join: no catalog squad named ${wanted}` : 'squad join: no catalog squad on creator');
    return;
  }
  log(`squad: ${invitees.map(c => c.name).join(', ')} accept invite to ${squad.name}`);
  const now = Date.now();
  for (const peer of invitees) {
    try {
      await acceptSquadInviteOnClient(peer, squad.id, squad.name, now, { creator: first });
    } catch (err) {
      log(`  ${peer.name}: accept failed: ${err.message}`);
    }
  }
  for (const client of [first, ...invitees]) {
    try {
      await withMcp(client.ports.mcpBridge, async bridge => {
        await reloadWebview(bridge, pin);
      });
    } catch (err) {
      log(`  client ${client.index}: reload failed: ${err.message}`);
    }
  }
}

export async function cmdSquad(args) {
  const { state, clients, pin } = await loadLiveSession(args);
  if (args.join) {
    await joinExisting({ clients, pin }, { all: Boolean(args.all), name: args.name });
  } else {
    await run({ clients, pin }, { all: Boolean(args.all), name: args.name });
  }
  writePidsFile(state);
}
