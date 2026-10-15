# Scripts

Place thin, single-purpose automation entry points here. Put reusable logic in the runtime-specific source area chosen for the project rather than copying business rules between scripts.

Before adding a script:

1. Create and review a specification from `templates/script-spec.md`.
2. State whether it reads or mutates data and what permissions it requires.
3. Include a dry-run for mutations and protect against duplicate effects.
4. Add tests using synthetic data and document invocation and recovery.

No executable script is included until the project runtime and the first automation's requirements are agreed.
