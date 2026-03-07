# Lore Operating Loop

## Quick Checks

- `lore status --json`
- `lore ls --json`
- `lore show <concept>`
- `lore ask "<query>" --sources`

Use these first to confirm whether the lore is already trustworthy enough to start coding.

## Bootstrap A New Repo

1. Run `lore init <path>` if the repo is not registered.
2. Run `lore ingest` to populate the lake and symbol index.
3. Open a narrative per subsystem instead of trying to explain the whole repo in one thread.
4. Journal what is structurally true, not just what files exist.

Example:

```bash
lore init .
lore ingest
lore open bootstrap-auth "Map the auth subsystem and establish the first concept" --target create:auth-model
lore write bootstrap-auth "authenticateUser gates both password and token refresh paths, so failures here cascade into session creation and refresh semantics." --concept auth-model --symbol authenticateUser --ref src/auth.ts:12-88
lore close bootstrap-auth --wait
```

## Fix A Bug In A Known Area

1. Ask for context first.
2. Open a narrative tied to the bug.
3. Journal the root cause and the constraint that makes the fix correct.
4. Close, ingest, and bind the touched symbols.

Example:

```bash
lore ask "how does auth refresh work?" --sources
lore open fix-auth-refresh "Investigate and fix the refresh token race" --target update:auth-model
lore write fix-auth-refresh "Two concurrent refresh calls both pass the expiry check before either writes the rotated token, so the race is caused by the pre-write validation window." --concept auth-model --symbol refreshToken --ref src/auth.ts:44-97
lore close fix-auth-refresh --wait
lore ingest src/auth.ts
lore sys concept bind auth-model refreshToken
```

## Add A Feature In Unfamiliar Territory

1. Use `lore ask` and `lore show` before grepping blindly.
2. Open a narrative with create targets if the feature introduces a new concept.
3. Journal integration points and ordering constraints as you discover them.

Example:

```bash
lore ask "where would webhook delivery fit?" --sources
lore open add-webhooks "Add webhook delivery for event notifications" --target create:webhook-delivery
lore write add-webhooks "Webhook delivery hangs off EventBus fan-out rather than the persistence layer, so retry semantics belong in the delivery worker instead of the event writer." --concept webhook-delivery --symbol deliverWebhook --ref src/webhooks.ts:1-120
```

## Research Or Investigation Work

- Open one narrative per investigation.
- Write findings as they are discovered, including failed leads.
- Use `lore trail <narrative>` later to reconstruct the investigation history.

## Maintenance And Drift Work

- Start with `lore status` and `lore suggest`.
- Open a narrative for meaningful maintenance, not for trivial formatting.
- Use `lore ingest` after restructuring files so drift detection has fresh source state.

## Async Close Patterns

- Use `lore close <narrative>` when the caller can continue while merge work runs.
- Use `lore close <narrative> --wait` when the next step depends on the integrated concept state.
- Inspect queue state with `lore jobs`.
- Inspect one job with `lore job <id>`.
- Wait with `lore wait <id>`.
- Run a background drain loop with `lore sys worker --watch` in heavier automation.

## Good Journal Entry Shape

Prefer entries like:

- "X is computed before Y is applied, so changes to X always affect Y in the same reconcile cycle."
- "The gate sits inside the loop, so it serializes both image changes and hash changes even though those mechanisms are otherwise independent."
- "Tried approach A, but it fails because B survives restarts as persisted state rather than process memory."

Avoid entries that only restate the diff.
