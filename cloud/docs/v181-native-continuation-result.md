# Main-session native continuation delivery

## Cause

Gateway input admission and agent execution do not have a one-to-one identity.
A busy input can receive an empty terminal admission event, then execute as a
native queued follow-up with a different run ID. The previous adapter listened
only for IDs submitted by Doudou, so its answer existed in OpenClaw's transcript
without reaching product chat. Subsequent model responses could refer to that
undelivered answer.

## Change

- Observe execution lifecycle and output events for the exact main session,
  including runs started by OpenClaw after admission.
- Register these executions for product tools, activity tracking, busy state,
  cancellation and waiting. Completion of a preceding input cannot delete the
  continuation's tool context.
- Recover interrupted executions using native `agent.wait`; never resubmit a
  question to recover a missing reply.
- Suppress repeated terminal delivery with a stable native reply ID. Reuse the
  existing chat log for restart deduplication; no additional transcript or
  memory store.
- Keep quiet heartbeat results out of chat and keep isolated sessions separate.

The default input mode remains `steer`; the single continuous main session and
the OpenClaw kernel are unchanged. No app protocol or client build changes.

## Validation, 2026-10-22

- `npm run check`: passed.
- `npm test`: 159 passed, 0 failed in the shared working tree.
- The exact committed tree was separately exported to an isolated temporary
  directory: `npm test` passed 155 tests, 0 failed. The shared tree also contained
  four unrelated connector tests; those changes were excluded from this fix.
- `node scripts/verify-main-steering.mjs`: real OpenClaw 2026.10.4, local
  synthetic Anthropic HTTP/SSE service; busy inputs reach the model and all
  generated answers reach visible chat; 3 model requests.
- `node scripts/verify-main-continuation.mjs`: real OpenClaw 2026.10.4 with a
  local synthetic model service; queued follow-up uses a different native run
  ID, both answers appear exactly once, a product tool runs with valid context,
  main-session waiting covers the continuation, disconnect recovery retrieves
  its terminal reply, and stop cancels another continuation; 5 model requests.
  Only this fixture selects native `followup` mode to exercise the queued path
  deterministically. Production continues to submit with `steer`.
- Gateway and presentation tests also cover repeated events, restart
  deduplication, quiet checks, isolated sessions and preceding-run cleanup.

These are protocol and product-presentation checks with synthetic model output.
They do not measure a production provider's reasoning quality. No Android or Mac
UI changes were made or claimed as newly tested.

## Deployment

After the existing background update finished, only `agent.mjs`,
`gateway-chat.mjs` and `openclaw-runtime.mjs` were installed on the cloud service,
with the previous files backed up. The restarted service reported `ok: true`,
`ready: true`, OpenClaw, app version 1.8.1 and protocol 2. All three deployed
source hashes matched the tested commit. No persistent data migration or client
reinstallation was required. Production provider output was not replaced with
synthetic messages for verification.
