# Mandatory-thinking model recovery

## Incident

The long main conversation reached its compaction boundary again. The native
summary request received HTTP 400 from the selected ZenMux GLM 5.3 Flash route:
the model requires thinking and rejects disabling it. Subsequent user messages
and scheduled heartbeats consequently failed at the same compaction step.

The earlier correction preserved the model's reasoning capability but assumed
that a reasoning model could disable thinking for summaries. The real-provider
probe used then did not exercise compaction. A small synthetic Messages request
now reproduces the rejection with `thinking.type = disabled` and succeeds with
thinking enabled and a low budget.

A separate evening crash exhausted the supervisor's hard-coded 512 MiB V8 heap
while deserializing a worker message. This was a V8 heap-limit failure, not proof
that the host's RAM or total service memory limit had been exhausted.

## Change

- Describe mandatory thinking in the existing shared model catalog:
  `thinkingLevelMap.off = low` for the verified ZenMux GLM route. Forward this
  metadata to the native model definition for either supported wire protocol.
  OpenClaw's own reasoning resolver and transport then form the supported
  request. Other models retain their existing behavior.
- Remove the separate 512 MiB heap flag. Node sizes its heap using the service's
  existing cgroup memory limit. Under the deployed 1,400 MiB limit, a real Node
  process reports a 748 MiB heap limit. The overall service limit is unchanged.
- Translate the native "couldn't shorten" failure through the existing product
  error mapping, preserving failure status and history without suggesting a
  session reset.

No upstream bundle patch, alternative execution path, user-message replay,
timeout increase or session reset is introduced. Removing the heap flag does
not establish that there is no memory leak or remove the host's paging pressure.

## Validation

- Shared-tree tests: 166 passed, including four unrelated connector tests.
- JavaScript checks and `git diff --check`: passed.
- Real-kernel context fixture with mandatory thinking: 270K remains below the
  boundary, 273K triggers a committed summary, the outgoing summary request has
  thinking enabled, and the next answer retains the marker in the same physical
  session. The mapping comes from the production model catalog.
- The optional-thinking fixture remains separate: models that accept disabling
  thinking continue to receive that setting for summaries.
- The mandatory-thinking fixture with a stalled summary also passes native
  automatic timeout reduction: original history is retained, the pending input
  completes, and the following turn does not repeat the same failed summary.

The local endpoint and usage numbers are synthetic; they test the protocol and
boundary, not the provider's performance.

## Production acceptance

The service was stopped while product work was idle. Its persistent data and
old runtime files were backed up privately before deploying the three runtime
modules. No client protocol or binary changed.

- The generated GLM model has the native `off -> low` mapping after restart.
- Real native compaction succeeded: 283,221 to 14,658 estimated active tokens,
  preserving the main physical session and original transcript. It took 317
  seconds, which is still slow.
- A real existing heartbeat was invoked through the product schedule endpoint
  after compaction. It completed in the main session, with its assistant result
  committed and the product activity marked done. This took 108 seconds, also
  too slow to count as a general latency repair.
- The 478 pre-existing product messages, 1,468 persistent data/memory files,
  provider settings, selected model and device registry were retained. The
  private snapshot comparison checks identities, file presence and settings
  hashes; it does not claim that ongoing agent-authored content never changes.
- No new service restart or model HTTP 400 occurred during the recovery and
  heartbeat observation. This bounded observation does not prove long-term
  memory stability.

The old host still pages under load. This recovery removes the reproduced
configuration rejection and the obsolete heap cap; it does not complete the
separately planned host migration or establish that OpenClaw's long-history
hydration has acceptable performance on this host.

Provider reasoning controls: [ZenMux documentation](https://zenmux.ai/docs/guide/advanced/reasoning.html).
