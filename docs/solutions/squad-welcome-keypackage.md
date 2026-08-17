# Squad accept needs a live invitee KeyPackage

## Symptom

`make up-full` / `make squad` creates the MLS group and sends the invite DM,
then logs `accept failed: no pending MLS welcome`. Bravo's log shows the
welcome arrived and failed:

`Error previewing welcome: Welcome("No matching key package was found in the key store.")`

Once MDK records that failure, `list_pending_mls_welcomes` stays empty for
that wrapper.

## Cause

`create_group_chat` gift-wraps a Welcome against a KeyPackage event fetched
from relays. That event must still have a matching private init key in the
invitee's MLS store.

The previous squad path called `regenerate_device_keypackage({ cache: true })`
on every member immediately before create. A cache miss (or the store-reset
that runs at the start of regenerate) publishes or orphans a package the
creator is about to wrap. The welcome then cannot be previewed, so Accept
never sees a pending row.

## Invariant

- Publish a device KeyPackage at session create (already done). Do not rotate
  it again just before `create_group_chat`.
- Creator must see at least one package via `refresh_keypackages_for_contact`
  before create. Only if that fetch is empty should the invitee publish a
  fresh package (`cache: false`), then wait for the creator to see it.
- If no pending welcome appears, republish the invitee's package and call
  `invite_member_to_group` so a new Welcome is wrapped against the live key.

## Source

- `src/scenarios/squad.mjs`
- pacto-app `create_group_chat`, `invite_member_to_group`,
  `regenerate_device_keypackage`, `list_pending_mls_welcomes`

## Verify

`make up-full` (or `make squad` on a live session): Bravo logs Accept or
`accepted MLS welcome`, and both clients show the new squad in the catalog.
