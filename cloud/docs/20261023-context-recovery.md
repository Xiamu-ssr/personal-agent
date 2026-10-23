# Long-session context and reply recovery

## Cause

Production used OpenClaw 2026.10.4. Four attempts to compact the main conversation
timed out on the investigation day, each occupying roughly 3–5 minutes. The old
summary path could send a very large transcript to the model. Memory pressure
and paging on the small server also delayed execution and database operations.

The adapter additionally conflated three budgets: the model window, active input
budget and compaction point. Setting both window and input budget to 272K made
OpenClaw's internal 20K reserve move the pressure boundary to 252K.

## Changes

- Pin the kernel and Gateway client to stable OpenClaw 2026.10.5. Use its bounded
  summary input and native automatic timeout reduction; do not patch its bundle.
- Keep the 272K conversation compaction point, add the native 20K reserve to the
  active budget, and retain the selected 128K output policy. Model window
  metadata no longer doubles as the compaction point.
- Disable extra thinking for summaries. Explicitly enable Memory Core and its
  native retrieval tools alongside the Doudou plugin.
- Preserve known model capabilities across a vendor's Anthropic and OpenAI
  endpoints. Losing GLM's reasoning capability meant the native transport omitted
  its explicit disabled-thinking setting, even with compaction thinking set off.
- If a reconnected native run reports success without a terminal reply, read
  its committed transcript. Match the exact native run or accepted input and
  its own completed turn, never an arbitrary latest assistant message. Expand
  truncated previews through the native message endpoint. Missing proof remains
  an unknown outcome; no question or external action is replayed.
- Honor cancellation while an activity is waiting for its queued inputs, even
  after the first answer has completed.
- Context/provider failures remain failures, with concise product-facing text
  instead of instructions to reset the user's continuous session.

The original transcript remains the authoritative conversation record. No
second memory store, session reset, manual history slicing or timeout increase
is introduced. App protocol and client binaries are unchanged.

## Local validation

- `npm run check`: passed.
- Shared working tree: `npm test`, 165 passed, 0 failed. Four tests belong to
  unrelated connector work and are excluded from this change.
- The exact committed runtime tree was exported into an isolated directory:
  `npm test`, 161 passed, 0 failed.
- `node scripts/verify-openclaw.mjs`: real 2026.10.5 kernel, native memory tool
  recall, product tool execution, same-session continuation, restart and stop.
- `node scripts/verify-context-policy.mjs`: a real kernel with a synthetic local
  Anthropic endpoint; 270K reported usage does not compact, 273K does. A marker
  survives compaction and the physical main session ID stays the same. The
  summary request itself carries `thinking.type = disabled`.
- `node scripts/verify-context-policy.mjs --summary-timeout`: fixture-only
  one-second summary deadline and a stalled local endpoint; native timeout
  reduction commits, original transcript remains, the pending question runs,
  and the following turn does not repeat the same failed summary.
- Real-kernel steering, queued continuation and reconnection fixtures: all
  generated answers reach chat once, tools retain activity context, reconnect
  does not resubmit input, and stopping a continuation records a stopped state.

These local model responses and usage numbers are synthetic. They verify native
protocol, compaction boundaries and product delivery, not provider latency or
reasoning quality. No Mac or Android UI change is claimed.

## Production

Only the kernel dependencies, four runtime modules and installer were updated.
Unrelated connector implementation changes in the shared checkout were excluded.
The service was stopped after product work settled; persistent data, environment
configuration and old code were backed up outside the live data directory.

The official package lifecycle was completed by the installer, and offline
`openclaw doctor --fix --non-interactive` migrated agent schema 24 to 25. An HTTP
health response alone did not prove that this migration was complete; native
session access was also checked. The deployment guide and installer now cover
both requirements.

- Production runs OpenClaw 2026.10.5. Main session identity was unchanged.
- All 442 existing product chat messages and 465 persistent memory/content files
  were retained. Provider configuration, selected model and device registry
  remained byte-identical.
- Native `sessions.compact`, without trimming parameters, reduced the real main
  conversation from 260,430 to 26,452 estimated active tokens. Its full original
  transcript remains. This initial operation took 320 seconds, before the final
  vendor-capability correction; it is not evidence of low compaction latency.
- After correcting capabilities, an isolated real-provider session read a
  temporary file through native tools and returned its unpredictable marker in
  27 seconds. The diagnostic session and file were removed. No synthetic user
  message was inserted into product chat or the main native conversation.
- Saving the unchanged selected model through the actual settings endpoint
  regenerated the correct reasoning capability and did not alter settings bytes.
- No client binaries changed or required reinstallation.

The server still has approximately 1.9 GiB of RAM and significant swap use.
Replacing the kernel did not remove that capacity bottleneck. Sustained busy
work on this host can still page and delay operations; the separate server
migration remains necessary. Provider refusal and upstream connection failures
remain explicit failed outcomes rather than fabricated success.

Upstream: [2026.10.5 release](https://github.com/openclaw/openclaw/releases/tag/v2026.10.5).
