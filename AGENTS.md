# Agent Operating Rules

Use [CONTEXT.md](CONTEXT.md) for project vocabulary and the detailed authority/navigation map. Keep this file focused on normative operating rules; do not duplicate contracts or implementation documentation here.

## Authority by concern

Production code and tests establish current behavior; contracts establish intended guarantees and ownership; accepted ADRs establish architectural decisions. These are different concerns, not a precedence ranking. See [CONTEXT.md](CONTEXT.md) for documentation navigation.

Check an accepted ADR's implementation/adoption status before comparing it with runtime behavior; differences consistent with explicitly partial or deferred adoption are expected, not drift. If runtime behavior contradicts an implemented contract or guarantee, or an ADR decision that should already apply, report implementation/documentation drift requiring reconciliation. Never assume an accepted ADR is fully implemented or resolve conflicts by ranking sources.

## Working rules

- Ground changes in repository evidence. Before changing behavior, inspect the production code and relevant tests, and trace the affected flow far enough to understand its callers and ownership boundaries.
- Follow applicable contracts and accepted ADRs. Preserve the established architecture and repository conventions; do not infer ownership from a feature's name or documentation alone.
- Keep changes within the requested scope and preserve existing behavior unless a behavior change is explicitly required. Prefer the smallest clear solution; avoid speculative abstractions and unrelated cleanup.
- Reuse existing dependencies and configuration patterns. Use the repository's pnpm tooling. Do not migrate Vite configuration from JavaScript to TypeScript or use APIs/configuration from newer major dependency versions unless explicitly requested.
- Add or update focused tests for behavior changes. Run the relevant checks and report what was run and any failures or skips.
- Update documentation when a change materially changes behavior, guarantees, ownership, or architecture—not for routine implementation details. Keep comments, JSDoc, and structured logs accurate when modifying the logic they describe.
- Use brainstorming or clarification only when requirements, scope, behavior, or intended direction are genuinely unclear; do not delay a well-specified task.
