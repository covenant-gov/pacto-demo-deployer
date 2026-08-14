import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUPS_DIR,
  MESSAGE_ID_WAIT_MS,
  NATO_WORDS,
  PIN_UNLOCK_WAIT_MS,
  SESSION_WAIT_MS,
  demoPin,
} from './config.mjs';
import { invokeTauri, waitForTauri, withMcp, executeJs } from './mcp.mjs';
import { isAlive, log, readPidsFile, sleep, writePidsFile } from './process.mjs';

export function demoNameForIndex(index) {
  const i = index - 1;
  const word = NATO_WORDS[i % NATO_WORDS.length];
  const round = Math.floor(i / NATO_WORDS.length);
  return round === 0 ? `${word}-test` : `${word}-test-${round + 1}`;
}

export function namedClients(clients) {
  return clients.filter(c => c.npub);
}

export function demoLeadAndOthers(named) {
  const first = named.find(c => c.index === 1) || named[0];
  const others = named.filter(c => c !== first);
  return { first, others };
}

async function pinUnlockUiState(bridge) {
  try {
    return await executeJs(
      bridge,
      `(() => {
        const title = document.querySelector('.pin-title')?.textContent?.trim() || '';
        const login = !!document.querySelector('.login-container');
        return { title, login };
      })()`,
    );
  } catch {
    return null;
  }
}

async function pasteUnlockPin(bridge, pin) {
  const script = `(() => {
    const title = document.querySelector('.pin-title')?.textContent?.trim() || '';
    if (title !== 'Enter your PIN') return { ok: false, reason: 'not-unlock', title };
    const inputs = Array.from(document.querySelectorAll('input.pin-digit'));
    if (!inputs.length) return { ok: false, reason: 'no-input' };
    const pin = ${JSON.stringify(pin)};
    const first = inputs[0];
    first.focus();
    let filled = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text', pin);
      dt.setData('text/plain', pin);
      first.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }));
      filled = inputs.every((el, i) => el.value === pin[i]);
    } catch {
      filled = false;
    }
    if (!filled) {
      pin.split('').forEach((digit, i) => {
        const el = inputs[i];
        if (!el) return;
        el.focus();
        el.value = digit;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    return { ok: true };
  })()`;
  await executeJs(bridge, script);
}

export async function unlockPinUiIfNeeded(bridge, pin) {
  if (!pin) return;
  const appearDeadline = Date.now() + 5_000;
  let sawUnlock = false;
  while (Date.now() < appearDeadline) {
    const state = await pinUnlockUiState(bridge);
    if (!state) {
      await sleep(250);
      continue;
    }
    if (!state.login) return;
    if (state.title === 'Enter your PIN') {
      sawUnlock = true;
      break;
    }
    if (state.title) return;
    await sleep(250);
  }
  if (!sawUnlock) return;

  let lastPaste = 0;
  const goneDeadline = Date.now() + PIN_UNLOCK_WAIT_MS;
  while (Date.now() < goneDeadline) {
    const state = await pinUnlockUiState(bridge);
    if (!state) {
      await sleep(400);
      continue;
    }
    if (!state.login || state.title !== 'Enter your PIN') return;
    if (Date.now() - lastPaste > 1_500) {
      try {
        await pasteUnlockPin(bridge, pin);
        lastPaste = Date.now();
      } catch {
        // retry while the unlock form is still up
      }
    }
    await sleep(400);
  }
}

export async function reloadWebview(bridge, pin) {
  try {
    await executeJs(bridge, '(() => { window.location.reload(); return true; })()');
  } catch {
    // reload can tear down the executing context
  }
  await sleep(1_500);
  await waitForTauri(bridge);
  await unlockPinUiIfNeeded(bridge, pin);
}

export async function tryCurrentAccount(bridge) {
  try {
    const npub = await invokeTauri(bridge, 'get_current_account');
    if (typeof npub === 'string' && npub.startsWith('npub1')) return npub;
  } catch {
    return null;
  }
  return null;
}

export async function waitForAccount(bridge, timeoutMs = SESSION_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const npub = await tryCurrentAccount(bridge);
    if (npub) return npub;
    await sleep(1_000);
  }
  return null;
}

async function createHeadlessAccount(bridge, pin) {
  const keys = await invokeTauri(bridge, 'create_account');
  const encrypted = await invokeTauri(bridge, 'encrypt', { input: keys.private, password: pin });
  await invokeTauri(bridge, 'set_pkey', { pkey: encrypted });
  if (keys.evm_private_key && keys.evm_address) {
    const evmEnc = await invokeTauri(bridge, 'encrypt', {
      input: keys.evm_private_key,
      password: pin,
    });
    await invokeTauri(bridge, 'set_evm_pkey', { evmPkey: evmEnc });
    await invokeTauri(bridge, 'set_evm_address', { address: keys.evm_address });
  }
  await invokeTauri(bridge, 'connect');
  try {
    await invokeTauri(bridge, 'regenerate_device_keypackage', { cache: true });
  } catch {
    // keypackage publish is best-effort; squad loop retries
  }
  await reloadWebview(bridge, pin);
  const npub = await waitForAccount(bridge, 10_000);
  if (!npub) throw new Error('create_account succeeded but no current account after reload');
  return npub;
}

async function unlockWithPin(bridge, pin) {
  const encryptedKey = await invokeTauri(bridge, 'get_pkey');
  if (!encryptedKey) return null;
  const decrypted = await invokeTauri(bridge, 'decrypt', {
    ciphertext: encryptedKey,
    password: pin,
  });
  await invokeTauri(bridge, 'login', { importKey: decrypted });
  return waitForAccount(bridge, 10_000);
}

async function persistSeedBackup(bridge, client, npub) {
  let phrase = '';
  try {
    const seed = await invokeTauri(bridge, 'get_seed');
    if (typeof seed === 'string') phrase = seed.trim();
  } catch {
    return false;
  }
  if (!phrase) return false;
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const dest = path.join(BACKUPS_DIR, `client-${client.index}.txt`);
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes(phrase)) return true;
  }
  const body = `# ${client.identifier}  ${npub}  ${new Date().toISOString()}\n${phrase}\n`;
  fs.writeFileSync(dest, body, { mode: 0o600 });
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // best-effort
  }
  log(`    wrote recovery phrase to backups/client-${client.index}.txt`);
  return true;
}

async function markBackupVerified(bridge) {
  try {
    await invokeTauri(bridge, 'set_sql_setting', { key: 'backup_verified', value: 'true' });
  } catch {
    // no account db yet
  }
}

export async function ensureSession(bridge, pin, client) {
  await waitForTauri(bridge);
  let npub = null;
  if (client.seeded) {
    npub = await waitForAccount(bridge, SESSION_WAIT_MS);
  } else {
    npub = await tryCurrentAccount(bridge);
  }
  if (!npub) {
    try {
      npub = await unlockWithPin(bridge, pin);
    } catch {
      // no stored key, or wrong PIN — create instead
    }
  }
  if (!npub) {
    log('    no session; creating a fresh account');
    npub = await createHeadlessAccount(bridge, pin);
  }
  await markBackupVerified(bridge);
  let backed = await persistSeedBackup(bridge, client, npub);
  await unlockPinUiIfNeeded(bridge, pin);
  if (!backed) await persistSeedBackup(bridge, client, npub);
  return npub;
}

export async function lastOutboundMessageId(bridge, peerNpub, content) {
  const deadline = Date.now() + MESSAGE_ID_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const msgs = await invokeTauri(bridge, 'get_message_views', {
        chatId: peerNpub,
        limit: 20,
        offset: 0,
        virtualBucketFilter: null,
      });
      const list = Array.isArray(msgs) ? msgs : [];
      const hit = [...list]
        .reverse()
        .find(
          m =>
            m &&
            m.mine &&
            m.content === content &&
            m.id &&
            !String(m.id).startsWith('pending-'),
        );
      if (hit) return hit.id;
    } catch {
      // chat may not exist yet
    }
    await sleep(500);
  }
  return null;
}

async function currentProfileName(bridge, npub) {
  try {
    const profile = await invokeTauri(bridge, 'get_profile', { npub });
    return typeof profile?.name === 'string' ? profile.name : '';
  } catch {
    return '';
  }
}

export async function setupDemoName(client, pin) {
  const name = demoNameForIndex(client.index);
  log(`  client ${client.index}: session + profile ${name}`);
  const npub = await withMcp(client.ports.mcpBridge, async bridge => {
    const account = await ensureSession(bridge, pin, client);
    const existing = await currentProfileName(bridge, account);
    if (existing === name) {
      log(`    name already ${name}; skipping profile update`);
      return account;
    }
    try {
      await invokeTauri(bridge, 'connect');
    } catch {
      // UI unlock / autologin may still be opening relays
    }
    try {
      await invokeTauri(bridge, 'update_profile', {
        name,
        avatar: '',
        banner: '',
        about: '',
      });
    } catch (err) {
      log(`    profile update skipped: ${err.message}`);
    }
    await reloadWebview(bridge, pin);
    return account;
  });
  client.name = name;
  client.npub = npub;
  log(`    ${name} ${npub}`);
}

export async function loadLiveSession(args) {
  const state = readPidsFile();
  const live = (state?.clients ?? []).filter(c => isAlive(c.pid));
  if (live.length === 0) {
    throw new Error('no running demo clients (run make up first)');
  }
  const pin = demoPin(args);
  for (const client of live) {
    if (!client.name) client.name = demoNameForIndex(client.index);
    if (client.npub) continue;
    try {
      const npub = await withMcp(client.ports.mcpBridge, async bridge => {
        await waitForTauri(bridge);
        return tryCurrentAccount(bridge);
      });
      if (npub) client.npub = npub;
    } catch (err) {
      log(`  client ${client.index}: could not read npub: ${err.message}`);
    }
  }
  writePidsFile(state);
  return { state, clients: live, pin };
}
