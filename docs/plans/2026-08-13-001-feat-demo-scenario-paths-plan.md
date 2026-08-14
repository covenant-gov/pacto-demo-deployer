# Demo scenario paths

Plan only. Do not implement these registry ids in the same change as the
`src/scenarios/` split. Each later branch adds `src/scenarios/<id>.mjs` and one
row in `src/scenarios/index.mjs`.

Sources: [pacto-app](https://github.com/covenant-gov/pacto-app) contributor docs
(local copy: sibling `pacto-app-demo/docs/` when present).

## Non-goals

- No mainnet.
- Never log seed phrases.
- Never touch `io.pacto`.
- Do not re-plan shipped ids: `broadcast`, `dm`, `squad` (create + invite + accept), `squad --join`.

## Shipped

| Id | Make | CLIENTS | Verify |
| --- | --- | --- | --- |
| `broadcast` | `make up` | 1+ | Commons shows each client's user card |
| `dm` | `make dm` | 2+ | alpha→others hello; replies |
| `squad` | `make squad` | 2 | `alpha-squad-test-<n>` on both; bravo Accept |
| `squad` + `--join` | `make squad-join` | 2 | Accept pending invite without creating another squad |

## Near (2 clients, MCP-only, no Sepolia funds)

| Id | Make | CLIENTS | Commands / JSON | Verify |
| --- | --- | --- | --- | --- |
| `announcements-post` | `make announcements-post` | 2 | `message` to announcements `groupId` | Bravo sees Kind 444 in `#announcements` |
| `squad-channel` | `make squad-channel` | 2 | `create_group_chat` + `invite_member_to_group`; DM `channel_in_squad` | Bravo Accept; extra channel in catalog |
| `polls` | `make polls` | 2 | `sendDashboardPollCreate` / vote (`pacto.dashboard_poll.v1`) | Both see poll card + Polls tab; last vote wins |
| `roster-bind` | `make roster-bind` | 2 | `#personal-alerts` bind `squad_member_evm_account`; share on announcements | Bravo bound; share on `#announcements` |
| `attachments-dm` | `make attachments-dm` | 2 | `file_message` Kind 15 | Bravo decrypts/opens the blob |
| `dm-delete` | `make dm-delete` | 2 | `delete_dm_chat` then later `message` | Later alpha note lands as Request |

Docs: communities DESIGN, messaging OVERVIEW, POLLS, ACCESS_CONTROL, ATTACHMENTS.

## Mid (often 3 clients, still off-chain)

| Id | Make | CLIENTS | Commands / JSON | Verify |
| --- | --- | --- | --- | --- |
| `commons-join` | `make commons-join` | 3 | Commons Request to join → join inbox; `#join-requests` admit | Charlie in MLS after alpha admits |
| `invite-existing` | `make invite-existing` | 3 | `invite_member_to_group` (not create-with-members) | Charlie pending welcome then Accept |
| `leave` | `make leave` | 2 | `leave_mls_group` | Alpha sees `squad_member_left` on announcements |
| `kick` | `make kick` | 2 | `remove_member_device` | Bravo group evicted; creator-only MLS admin today |
| `wallet-peer` | `make wallet-peer` | 2 | `wallet_peer_info_request` / grant / decline | DM Send/Request unlocked; no Kind 0 EVM |

Docs: COMMONS, SQUAD_BOT_JOIN, INVITES_AND_MEMBERSHIP, EVICTION_AND_LEAVE, DM_WALLET_MESSAGE_SCHEMA.

## Later (Sepolia / more clients / research)

| Id | Make | CLIENTS | Commands / JSON | Verify |
| --- | --- | --- | --- | --- |
| `wallet-tx` | `make wallet-tx` | 2 | `wallet_tx_request` + send + `wallet_tx_announcement` | Receipt card in DM; needs funded Default |
| `gov-deploy` | `make gov-deploy` | 2 | Deploy Pacto Gov + squad sponsor | `#announcements` `governance_updated`; ACL snapshot |
| `gov-crew` | `make gov-crew` | 2+ | Bootstrap Crew hats; treasury propose/vote/execute | Fail-closed if unbound; hats on Roles |
| `squad-pair` | `make squad-pair` | 3–4 | Two anchor squads, then Pair with squad… | Partner squad listed on both anchors |
| `networks` | — | ? | Research-first | Product README lists squad-of-squads; confirm a shipped path before coding |

Docs: OPERATOR_SMOKE, MANUAL_E2E_CHECKLIST, PACTO_GOV, ACCESS_CONTROL, communities DESIGN.

## How to add one

1. Agree the row (id, CLIENTS, verify).
2. Implement `src/scenarios/<id>.mjs` exporting `run(ctx, opts)`.
3. Register it in `src/scenarios/index.mjs`.
4. Wire CLI / Makefile only if operators should run it alone.
