import { DEFAULT_APP_REMOTE, SEED_ENV_RE } from './config.mjs';

/**
 * High-value credentials that must not ride into `pnpm install` or `tauri
 * dev` via inherited process.env. Deployer-side `git` / `gh` keep the parent
 * environment so PR metadata fetch still works.
 */
export const CHILD_ENV_CREDENTIAL_DENYLIST = Object.freeze([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CI_JOB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_CI_TOKEN',
  'CARGO_REGISTRY_TOKEN',
  'PPROF_TOKEN',
]);

const DENYLIST_SET = new Set(CHILD_ENV_CREDENTIAL_DENYLIST);

export function normalizeRemoteUrl(remote) {
  return String(remote ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function isDefaultAppRemote(remote) {
  return normalizeRemoteUrl(remote) === normalizeRemoteUrl(DEFAULT_APP_REMOTE);
}

/** Truthy opt-in: 1 / true / yes / on (case-insensitive). */
export function isOptInTruthy(value) {
  if (value == null) return false;
  if (value === true) return true;
  const raw = String(value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * PR checkouts and non-default remotes need an explicit operator opt-in
 * before install / build / run. Default-remote branch / PR=0 → main do not
 * trip this gate (they are still not a safety claim).
 */
export function checkoutNeedsTrustConsent(ref, remote) {
  if (ref?.kind === 'pr') return true;
  if (!isDefaultAppRemote(remote)) return true;
  return false;
}

export function trustConsentMessage({ ref, remote }) {
  const target =
    ref?.kind === 'pr'
      ? `PR #${ref.pr}${ref.url ? ` (${ref.url})` : ''}`
      : ref?.label
        ? String(ref.label)
        : 'this checkout';
  const remoteNote = isDefaultAppRemote(remote)
    ? ''
    : ` Remote ${normalizeRemoteUrl(remote)} is not the default pacto-app remote.`;
  return (
    `Refusing to install or run ${target} without explicit operator consent.${remoteNote} ` +
    `Pass --trust-checkout or set PACTO_DEMO_TRUST_CHECKOUT=1 after you accept that this ` +
    `runs third-party checkout code (pnpm install, tauri/Rust build, and the app) on this machine. ` +
    `Consent is not a safety guarantee; --ignore-scripts alone does not sandbox build or runtime. ` +
    `See docs/security/OPERATOR_TRUST_BOUNDARY.md.`
  );
}

export function assertCheckoutConsent({ ref, remote, trusted }) {
  if (!checkoutNeedsTrustConsent(ref, remote)) return false;
  if (isOptInTruthy(trusted)) return true;
  throw new Error(trustConsentMessage({ ref, remote }));
}

export function resolveAllowInstallScripts(value) {
  return isOptInTruthy(value);
}

/** argv for `pnpm` after the binary name. */
export function pnpmInstallArgs({ allowInstallScripts = false } = {}) {
  const args = ['install', '--frozen-lockfile'];
  if (!allowInstallScripts) args.push('--ignore-scripts');
  return args;
}

/**
 * Copy env for child install/build processes: drop denylisted credentials
 * and numbered demo seed slots (seeds are re-injected as
 * PACTO_DEV_LOGIN_MNEMONIC only when launching a client).
 */
export function scrubChildEnv(sourceEnv = process.env) {
  const out = { ...sourceEnv };
  for (const key of Object.keys(out)) {
    if (DENYLIST_SET.has(key) || SEED_ENV_RE.test(key)) {
      delete out[key];
    }
  }
  return out;
}
