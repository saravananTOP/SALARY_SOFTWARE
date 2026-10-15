# Script authoring standards

Use these standards for every automation added to `scripts/`.

## Define the contract

Document the purpose, owner, supported inputs, outputs, permissions, side effects, and expected volume. Specify required and optional arguments, defaults, validation, exit codes, and operational recovery in a script specification.

## Safe execution

- Provide a non-mutating dry-run for scripts that write data or call external services.
- Require explicit confirmation or an explicit flag for consequential production operations.
- Make repeated execution safe, or document why it is not and how duplicate effects are prevented.
- Validate all input before performing side effects; fail clearly rather than silently skipping invalid payroll records.
- Bound resource use and network operations with sensible timeouts and documented retry behavior.
- Do not include sensitive values in errors, logs, command output, or telemetry.

## Testability and operations

- Keep calculation and business logic callable independently from the command-line entry point.
- Test with synthetic fixtures, including boundary values, malformed input, partial failures, and reruns.
- Record operationally useful metadata (such as run ID and period) without recording unnecessary personal data.
- Document permissions, invocation examples, expected duration, rollback or recovery, and ownership.
- Add runtime-specific format, lint, type-check, and test commands to CI when the language is selected.
