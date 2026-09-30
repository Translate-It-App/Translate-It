# Repository Context

Use this page for shared vocabulary and documentation navigation. It summarizes terms; it does not replace contracts, ADRs, implementation guides, or production behavior.

## Authority by concern

These sources answer different questions; they are not a precedence ranking:

- **Current runtime behavior:** production code and tests.
- **Intended guarantees and ownership boundaries:** [technical contracts](docs/technical/contracts/README.md).
- **Accepted architectural decisions:** [accepted ADRs](docs/adr/).
- **System structure and runtime explanation:** [technical architecture overview](docs/technical/ARCHITECTURE.md) and [translation runtime guide](docs/technical/architecture/TRANSLATION_SYSTEM.md); for implementation details, consult the relevant guide in the [technical documentation index](docs/technical/README.md).
- **Future intent only:** roadmap and proposal documents; they do not establish deployed behavior.

Check each accepted ADR's implementation/adoption status before comparing it with code and tests. Differences consistent with explicitly partial or deferred adoption are expected, not drift. If runtime behavior contradicts an implemented contract or guarantee, or an ADR decision that should already apply, report implementation/documentation drift requiring reconciliation; neither source automatically overrides the other. Never assume acceptance means full implementation.

## Documentation navigation

- Runtime structure and routing: [architecture overview](docs/technical/ARCHITECTURE.md) and [translation runtime guide](docs/technical/architecture/TRANSLATION_SYSTEM.md).
- Guarantees and decisions: [contracts index](docs/technical/contracts/README.md) and [accepted ADRs](docs/adr/).
- Feature and subsystem details: [technical documentation index](docs/technical/README.md), including its provider and infrastructure guides.

## Repository tooling

- Package manager, dependencies, and runnable scripts: [package.json](package.json); workspace configuration: [pnpm-workspace.yaml](pnpm-workspace.yaml); dependency lock: [pnpm-lock.yaml](pnpm-lock.yaml).
- Test configuration: [tests/vitest.config.js](tests/vitest.config.js); JavaScript lint configuration: [config/eslint.config.js](config/eslint.config.js); style lint configuration: [config/.stylelintrc.json](config/.stylelintrc.json).
- Vite/build configuration: [config/vite/](config/vite/); build scripts: [scripts/build/](scripts/build/); validation tooling: [scripts/validate/](scripts/validate/).

Common commands: `pnpm test:run`, `pnpm lint`, `pnpm lint:styles`, `pnpm build`, `pnpm pre-submit`.

`package.json` remains authoritative for available commands; verify specialized or changing commands there rather than relying on copied documentation. Do not copy package or tool versions into this file.

## Translation vocabulary

- **Translation Operation** — execution-lifecycle boundary for translation work; distinct from feature mutation and presentation ([ADR-015](docs/adr/ADR-015-translation-outcome-semantics.md), [ADR-017](docs/adr/ADR-017-conversation-acceptance-lifecycle-ownership.md)).
- **Translation Outcome** — immutable semantic result model in ADR-015; its structural foundation exists, but universal runtime production and feature consumption remain deferred ([ADR-015](docs/adr/ADR-015-translation-outcome-semantics.md), [runtime guide](docs/technical/architecture/TRANSLATION_SYSTEM.md)).
- **Provider Completion / CompletionRecord** — normalized fact about a physical provider response, not proof of an accepted translation or conversation turn; implementation is partial ([ADR-016](docs/adr/ADR-016-provider-completion-contract.md), [conversation contract](docs/technical/contracts/CONVERSATION_CONTRACT.md)).
- **Structured Recovery** — provider-local recovery for a structured response contract violation; it is distinct from queue retry and API-key failover ([provider contract](docs/technical/contracts/PROVIDER_CONTRACT.md)).
- **Queue Retry** — execution retry scheduling owned by `QueueManager`, not a new semantic conversation turn ([provider contract](docs/technical/contracts/PROVIDER_CONTRACT.md), [conversation contract](docs/technical/contracts/CONVERSATION_CONTRACT.md)).
- **API-key Failover** — retrying a provider request with another key for the same provider; it does not switch providers ([provider contract](docs/technical/contracts/PROVIDER_CONTRACT.md)).
- **Provider Failover** — switching to another provider; the selected-provider runtime path does not do this automatically ([provider contract](docs/technical/contracts/PROVIDER_CONTRACT.md)).
- **Feature Workflow** — user-facing mode's owner of result application and source presentation; preserving source after failure is not source text returned as translated output ([feature contracts](docs/technical/contracts/FEATURE_CONTRACTS.md), [ADR-015](docs/adr/ADR-015-translation-outcome-semantics.md)).
- **Logical Parent** — semantic translation unit that may span multiple transport fragments; fragments do not become separate conversation turns ([conversation contract](docs/technical/contracts/CONVERSATION_CONTRACT.md), [identity and fragment contract](docs/technical/contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md)).
- **Final Acceptance** — point where a logical parent is fully reconstructed, validated, and accepted by the feature; it is separate from execution completion and DOM mutation ([conversation contract](docs/technical/contracts/CONVERSATION_CONTRACT.md), [ADR-017](docs/adr/ADR-017-conversation-acceptance-lifecycle-ownership.md)).
- **Conversation Turn** — accepted semantic translation context; provider responses, batches, retries, and recovery passes are not turns ([conversation contract](docs/technical/contracts/CONVERSATION_CONTRACT.md)).

### Identity terms

Identity values belong to different scopes and are not interchangeable ([identity and fragment contract](docs/technical/contracts/TRANSLATION_IDENTITY_AND_FRAGMENT_CONTRACT.md), [provider contract](docs/technical/contracts/PROVIDER_CONTRACT.md), [runtime guide](docs/technical/architecture/TRANSLATION_SYSTEM.md)):

- **`messageId`** identifies a translation request and its lifecycle; it is not a unit identity.
- **`unitId` / `requestIndex`** identify request-manifest membership and original position.
- **Logical ID**, **Positional Wire ID**, and **V3 Member ID** identify different structured-response namespaces; numeric response IDs are positional only in a proven positional-wire context.
- **`responseId`** is an identifier returned for an item in a structured provider response and matched to a request unit; the provider-assigned identity of an entire response/completion is a different scope ([ADR-016](docs/adr/ADR-016-provider-completion-contract.md)).
