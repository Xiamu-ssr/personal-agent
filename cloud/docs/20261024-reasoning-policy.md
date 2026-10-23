# Highest supported reasoning tier

Doudou now requests the selected model's highest supported reasoning tier for
conversation, background work, memory flush and compaction. The native default
and compaction preference are both `max`; OpenClaw resolves an unsupported Max
to the highest tier that the concrete model supports. This does not opt into
the harness's separate Ultra orchestration mode.

The shared catalog declares reasoning for the listed Claude models, allowing
the native family-specific resolver to select their supported tier. Unknown
models do not acquire invented reasoning capabilities.

ZenMux GLM Flash models use their native OpenAI-compatible model endpoint so
the request carries `reasoning_effort: max`. Their Anthropic-compatible endpoint
uses thinking-token budgets; OpenClaw caps that transport's Max budget at High,
and ZenMux converts budget ratios into effort, so a Max label there does not
establish a native Max request. The per-model API/base URL declarations use
OpenClaw's existing configuration support and the same configured vendor
credentials. Other models on the account retain their configured transport.

Validation:

- Real provider: both configured ZenMux GLM Flash variants accept a synthetic
  `reasoning_effort: max` request and return visible answers with reasoning.
- Real-kernel OpenAI wire fixture: every request, including memory flush and
  compaction, carries Max. The 270K/273K boundary, remembered marker and physical
  session identity remain correct.
- The same Max fixture with a stalled summary preserves original history and
  completes the pending turn through native automatic timeout reduction.
- An Anthropic model without a Max tier uses the native High budget instead.
- Shared-tree tests: 167 passed, including four unrelated connector tests;
  JavaScript checks and `git diff --check` passed.

The 272K compaction point, 128K output cap, main session and stored provider
credentials are unchanged. The wire fixtures use synthetic replies and usage;
they do not establish production response time.

Production acceptance:

- The generated normal and compaction defaults are Max. Startup reports the
  selected GLM with `thinking=max`; its model API is `openai-completions`.
- A fresh isolated native session, without a per-run thinking override, read an
  unpredictable file marker through the native tool and returned it. The real
  model requests returned HTTP 200; the diagnostic session and file were removed.
- The existing product heartbeat then completed in the original main session
  through the new transport in 18 seconds, including the previous transport's
  retained history. This single observation is not a latency benchmark.
- Main session identity, all pre-existing chat/data files and stored provider,
  selected-model and device settings passed the private snapshot comparison.
- No new service restart or model HTTP error was observed during acceptance.
