# SALARY_SOFTWARE

A foundation for maintainable, auditable salary and payroll automation. This repository starts with language-neutral engineering standards; choose and document a runtime before adding executable scripts.

## Project principles

- Treat payroll inputs and outputs as sensitive personal and financial data.
- Make calculations deterministic, reviewable, and reproducible.
- Use explicit validation, safe failure behavior, and auditable outcomes.
- Keep jurisdiction-specific rules configurable and effective-dated. Obtain qualified review before relying on tax, statutory, or legal calculations.
- Never commit credentials, employee records, payslips, or production exports.

## Repository layout

```text
docs/          Architecture and engineering guidance
scripts/       Operational and automation scripts
templates/     Reusable script design template
tests/         Test strategy and test data guidance
```

## Getting started

1. Read [script authoring](docs/script-authoring.md) and [architecture](docs/architecture.md).
2. Copy [the script specification](templates/script-spec.md) for each proposed automation.
3. Agree on the language, runtime, dependency management, and CI commands before adding executable code.
4. Review every change using the pull request template and test with synthetic data.

## Security and data handling

Do not put real payroll data or secrets in source control, test fixtures, logs, screenshots, or issue reports. Use synthetic data for development and testing. Report security concerns privately to the repository maintainers rather than opening a public issue.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before contributing.
