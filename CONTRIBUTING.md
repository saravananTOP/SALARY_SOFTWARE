# Contributing

## Before implementation

- Describe the business problem, data classification, owner, and expected outcome.
- Record inputs, outputs, validation rules, failure behavior, and whether the operation changes external state.
- For payroll or employee-data workflows, use synthetic examples and have an authorized domain owner review the requirements.
- Document the script using `templates/script-spec.md`.

## Change requirements

- Keep business rules separate from file, network, and database operations.
- Validate inputs explicitly and fail with a useful, non-sensitive error.
- Make write operations idempotent where possible; provide a dry-run mode for consequential changes.
- Use decimal-safe representations for money and document rounding rules. Do not use binary floating point for currency calculations.
- Avoid logging personal data, credentials, bank details, or full payroll records.
- Add tests for normal cases, boundaries, invalid input, and failure paths.
- Keep dependencies minimal, pinned or otherwise reproducibly resolved, and reviewed.

## Review checklist

- [ ] Requirements and script specification are current.
- [ ] Tests use synthetic data and cover relevant edge cases.
- [ ] Sensitive data and secrets are not included in changes or logs.
- [ ] Operational impact, rollback/recovery, and audit behavior are documented.
- [ ] The selected runtime's format, lint, type-check, and test commands pass.
- [ ] A domain owner reviewed changes to payroll rules.

Until a runtime is selected, executable-code checks are intentionally not prescribed. Add the chosen commands to the project documentation and CI configuration together.
