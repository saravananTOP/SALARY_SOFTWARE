# SALARY_SOFTWARE

A foundation for maintainable, auditable salary and payroll automation, including a Google Apps Script payroll portal connected to a protected Google Sheet.

## Project principles

- Treat payroll inputs and outputs as sensitive personal and financial data.
- Make calculations deterministic, reviewable, and reproducible.
- Use explicit validation, safe failure behavior, and auditable outcomes.
- Keep jurisdiction-specific rules configurable and effective-dated. Obtain qualified review before relying on tax, statutory, or legal calculations.
- Never commit credentials, employee records, payslips, or production exports.

## Payroll and employee portal

The **Employees Pay Roll** portal supports **THE FLAVORS INDIA PVT LTD** and **THE SUPREME AROMATICS PVT LTD**, uses INR, and treats the linked Google Sheet as the source of truth. It includes an employee directory and profile, attendance inputs and leave balances, selected-employee salary previews, reports, and a paginated read-only browser for the employee, leave, attendance, advance, salary, PF, ESI, bonus, gratuity, TDS, payslip, history, and report registers. The register browser masks sensitive columns server-side. Payroll previews include only employees explicitly selected in the UI and use the workbook's calculated values.

### Google Apps Script deployment

1. Use a native Google Sheets workbook. If the source file is Excel (`.xlsx`), first convert a copy to Google Sheets and leave the original unchanged; Apps Script's Spreadsheet service requires a native Google Sheets file. Set the source workbook's sharing to **Restricted** and share only with named authorized Google accounts.
2. Open the Apps Script project associated with the authorized native Google Sheet, or create a standalone Apps Script project.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\salary-processing\apps-script\build.ps1` from the repository root. This generates `salary-processing/apps-script/Index.html` by embedding the maintained HTML, CSS, and JavaScript. No synthetic employee data is included in the portal.
4. Add `Code.gs`, generated `Index.html`, and `appsscript.json` from `salary-processing/apps-script/` to the Apps Script project. Keep these files synchronized with this repository.
5. In Apps Script **Project Settings → Script Properties**, add `SPREADSHEET_ID` with the ID of the native Google Sheets copy. Optionally add `ALLOWED_EMAILS` as a comma- or semicolon-separated list of permitted Google account email addresses. Add `ADMIN_EMAILS` as a separate comma- or semicolon-separated list of administrators allowed to reveal full masked employee identifiers and bank/contact fields in a profile. Leave `ADMIN_EMAILS` unset until the portal administrator has explicitly authorized the accounts; without it, no portal user can reveal full values.
6. Deploy as a web app with the manifest's **Execute as: User accessing the web app** and **Who has access: Anyone with a Google account** settings. Do not use anonymous access or execute as the deployer. The Google Sheet's own restricted permissions remain the data-access control; optionally use `ALLOWED_EMAILS` as an additional portal restriction.
7. Open the deployed URL while signed in with an authorized Google account. Verify the company/staff classifications and workbook totals before relying on the portal.

The backend never returns unmasked protected fields with the initial portal data. Full values are fetched only after an administrator clicks **Show value**; the server rechecks the signed-in account against `ADMIN_EMAILS`, and logs the reveal event without logging the value. Other users see masked values. The portal sign-out clears its displayed data and returns to the sign-in gate, but does not sign the user out of their Google account. The backend only updates designated monthly attendance input columns; formula-driven calculations remain in the workbook. The Apps Script checks expected headers and refuses previews with invalid calculated amounts. Google Sheets enforces edit permission when saving attendance; a user with view-only access will receive the Sheet's write-permission error. Keep the spreadsheet ID in Script Properties and never commit employee records, credentials, payroll exports, or production data to this repository. The local HTML page does not contain payroll records; live records are loaded only by the deployed Google Apps Script portal.

**Workbook mapping and limitations:** `Employee Master - FA` is mapped to Flavors active staff, `Employee Master - FR` to Flavors retainers, and `Employee Master - SA` to Supreme retainers. Where the master has a date-of-birth field, age at joining is calculated server-side without sending the birth date; otherwise the portal displays the workbook's staff-type/group values and marks age unavailable. The connected workbook was checked against these tabs and the portal's attendance, leave, salary, history, and report column mappings. Its current `Settings!B4` is September 2026, while `Settings!B5` is 25 even though September has 30 calendar days. The portal displays this discrepancy and blocks payroll previews and attendance edits until the setting is corrected. Attendance and payroll formulas, statutory results, and historical values remain owned by the Sheet. The portal does not approve leave requests, archive payroll, reset monthly inputs, or initiate bank payments. Payslip and statutory registers are read-only. Treat authorized CSV exports as confidential.

## Repository layout

```text
docs/          Architecture and engineering guidance
scripts/       Operational and automation scripts
salary-processing/ Google Sheets-backed payroll portal; local page requires deployed portal for data
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
