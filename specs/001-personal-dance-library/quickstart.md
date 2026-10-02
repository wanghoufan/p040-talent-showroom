# Quickstart for Developer

1. Read `.specify/memory/constitution.md`, then `spec.md`, `plan.md`, `tasks.md`, then approved UI assets.
2. Optional once-only preflight input: ask for an AudD/ACRCloud key only if real recognition should be tested now. No key -> provider disabled/mock and continue.
3. Verify machine/ADB, locate latest P038 source only for shell reference.
4. Create new independent repo; copy approved reference assets into the exact paths from plan.
5. Establish Android shell + ADB live reload + debug APK prebuild before business logic.
6. Execute tasks strictly in ID order; mark evidence in `docs/verification/task-ledger.md`.
7. Do not interrupt the user for ordinary implementation choices. Use the defaults in plan.
8. Do not commit/push, delete apps/media, alter release signing/keystore, or perform other destructive actions before final Human Gate.
9. Human Gate only after every non-blocked task is complete and all quality gates have evidence.
