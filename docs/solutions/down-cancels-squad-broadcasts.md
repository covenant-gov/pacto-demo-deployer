# `down` must retract user and squad Commons broadcasts

## Symptom

`make down` removed each client's Commons user card but left the squad
"New squad: …" card live on Commons.

## Cause

`cancelDemoBroadcast` only called `commons_cancel_broadcast` with
`subject: 'user'`. Squad cards are a different subject: they are published
with `subject: 'squad'` and `subjectId` equal to the MLS group / catalog id.
Cancel is signed by the squad bot, so only a bot-key holder (the creator
after `squad_bot_init`) can retract it.

## Invariant

Before SIGTERM, each live `io.pacto.demo.<n>` client must retract:

- its user broadcast (`subject: 'user'`, `subjectId: npub`)
- every catalog squad (`list_squads` → `subject: 'squad'`, `subjectId: id`)

Invitees without bot keys fail with "Squad bot not initialized" or
"Only bot key holders"; treat that as an expected miss, not a down failure.
Do not cancel from the global Commons feed cache — that includes other
people's squads.

## Source

- `src/scenarios/broadcast.mjs` (`cancelDemoBroadcast`)
- `src/commands/lifecycle.mjs` (`stopClients`)
- pacto-app `commons_cancel_broadcast` / `list_squads`

## Verify

With a live `up` + `squad` session, `make down` then confirm Commons no
longer shows the demo user cards or the demo squad card.
