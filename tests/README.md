# Test strategy

Use synthetic data only. Tests must not depend on production systems, credentials, employee records, or current time unless those dependencies are controlled.

For payroll automation, cover at least:

- Valid ordinary inputs and documented business examples.
- Boundary conditions, effective-date transitions, and currency rounding.
- Invalid or incomplete records and useful, non-sensitive failure reporting.
- Repeated execution and duplicate-effect prevention for mutating workflows.
- External-service and storage failures, including partial completion and recovery.

When the project runtime is selected, put unit tests alongside or under its standard test directory and document the exact commands for unit, integration, and any required static checks.

The portal's server-side tests use Node's built-in test runner. Run `npm test` from `salary-processing/server/`; calculation, synthetic workbook import, payroll archive/rollover, SQLite persistence, local sign-in/session, and role-gating tests use synthetic data and temporary local database files. The test workbook contains no real employee or payroll data. Before production use, separately validate the importer against an approved source workbook and reconcile calculations with the organization's payroll reviewer.
