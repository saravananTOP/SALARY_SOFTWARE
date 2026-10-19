# SALARY_SOFTWARE

A locally authenticated payroll portal for maintaining employee records, entering attendance, calculating payroll, and retaining payroll history in SQLite.

## Payroll portal

The **Employees Payroll** portal supports **THE FLAVORS INDIA PVT LTD** and **THE SUPREME AROMATICS PVT LTD**, uses INR, and has no Google sign-in or Google Sheets runtime dependency. The supplied workbook is only a one-time migration source: the importer copies employee, attendance, settings, tax slabs, advances, and available payroll history into SQLite. The portal calculates and reads payroll data from SQLite after import.

The portal provides a local email/password sign-in, employee directory, attendance and leave inputs, selected-employee payroll previews, reports, and paginated employee, leave, attendance, advances, salary, PF, ESI, bonus, gratuity, TDS, payslip, and history registers. Sensitive employee fields are masked server-side. Administrators can reveal protected values, review ESI coverage, and use the **Source data review** screen to enter and verify missing salary and leave data. Each correction is audited; payroll preview and archive remain blocked until required active employee data is complete. Administrators and payroll users can update attendance and archive periods; read-only users cannot write. There is no public account registration or bank-payment integration.

### Monthly attendance, advances, and shared payroll rules

In **Attendance & leave**, an administrator or payroll user can import a complete monthly roster as CSV or `.xlsx`. The portal previews the file without changing data; confirmation validates it again and saves every row together. The import must contain exactly one row for every active employee, with these headers: `EMP ID`, `WORK DAYS`, `LEAVE DAYS THIS MONTH`, `LONGEST CONTINUOUS SPELL`, `PROCESS ALLOWANCE`, `PUNCTUAL INCENTIVE`, and `FULL ATT. BONUS`. Blank incentive amounts mean zero. Duplicate, unknown, inactive, missing, or invalid employee rows are rejected, and archived months cannot be changed. A downloadable blank CSV template is provided in the portal.

Administrators can add, update, or close employee advances and school loans in **Registers & rules**. Monthly deductions and balances feed future payroll calculations; archived payroll history remains unchanged. Administrators can also edit shared PF, ESI, bonus, gratuity, and related calculation assumptions under **Company settings**. The configured PF wage ceiling is the organization's approved ₹25,000 policy, not a claim about the current statutory ceiling. Health-insurance deductions remain a fixed amount per employee. Changes to employee fixed details and payroll data are administrator-controlled and audited. Confirm tax and statutory settings with the organization's accountant before relying on them.

### Test on this machine

1. Install Node.js 20 or newer.
2. In `salary-processing/server/`, run `npm install`.
3. Copy `.env.example` to `.env` and set a random `SESSION_SECRET` with at least 32 characters and the exact `APP_ORIGIN` used to open the portal. `DATABASE_PATH` defaults to `./data/portal.sqlite`.
4. Create the first administrator with `npm run users -- create admin@example.com admin`. The CLI prompts for a password without echoing it.
5. Issue a recovery key for each account with `npm run users -- recovery-key admin@example.com`. The CLI shows the key once; give it to the account holder through a secure channel and have them store it securely. Issuing another key replaces the previous key.
6. Import a synthetic or approved `.xlsx` source file and its validated leave-balance CSV as described below.
7. Run `npm test`, then start the local portal with `npm start`. It listens on `127.0.0.1:3000` by default.

Users can select **Forgot password?** and enter their account email, administrator-issued recovery key, and new password. Recovery keys are high-entropy, stored only as hashes, allowed five incorrect attempts, and invalidated after a successful reset. A successful reset revokes existing sessions. Issue a new recovery key after a reset for future use. The key is displayed only once by the local CLI; do not commit it or send it over an untrusted channel.

### Portable local launcher (Windows)

Move or copy the complete `salary-processing` folder to the Windows computer where the portal should run, install Node.js 20 or newer on that computer, then run `Start-Portal.ps1` from the folder. The launcher resolves paths relative to its own location, creates a local `.env` with a random session secret if needed, installs locked dependencies if absent, starts the server, and opens the browser. The portal and SQLite database remain on that computer; `http://127.0.0.1:3000` is not reachable from other computers or the public internet. Keep the generated `.env` and `server/data/portal.sqlite` private and back them up securely. To create the first administrator, follow the account setup command above in `salary-processing/server/`.

```powershell
.\Start-Portal.ps1
```

If PowerShell blocks local scripts, run it for this invocation without changing the machine-wide execution policy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Portal.ps1
```

### One-time workbook migration

The importer accepts the source `.xlsx` workbook and, when available, a CSV containing exactly one validated opening leave-balance row for each imported employee. CSV columns are `employeeId,elBalance,clBalance`. Missing salary, leave entitlements, or unverified opening balances remain explicitly incomplete in the portal; an administrator must enter and confirm values against authoritative records in **Source data review** before payroll can be previewed or archived. The workbook's saved values and headers must be complete for required imported fields; formulas with no saved result are not treated as valid numbers. The importer derives calendar days from the payroll period and warns if the workbook's calendar-day setting disagrees. It refuses to overwrite a database that already contains imported employees.

```powershell
cd salary-processing/server
npm run import-workbook -- "C:\secure\payroll-source.xlsx" --opening-balances "C:\secure\opening-balances.csv"
```

Keep the workbook, balances CSV, SQLite database, backups, and exports in restricted storage outside source control. Do not import real payroll data until employee mappings, opening balances, and the resulting calculations have been validated. Available archived payroll history is imported as-is; missing historical months are not reconstructed.

### Deploy on the organization server

Install Node.js 20+ on the target Windows or Linux server, copy the application, configure `.env`, create the first admin account, and perform the one-time import on that server. Use a persistent local disk for `DATABASE_PATH`; the default is `salary-processing/server/data/portal.sqlite`. Start one Node.js process with `npm start`, and place it behind the organization's HTTPS reverse proxy. Set `APP_ORIGIN` to the exact HTTPS portal origin and `TRUST_PROXY=true` when the proxy terminates TLS. Do not put a live SQLite database on a shared network drive or run multiple portal instances against the same file. If the organization later needs multiple application servers or heavier concurrent writes, migrate to a database service such as PostgreSQL.

Local accounts are managed from `salary-processing/server/`:

- Create: `npm run users -- create <email> <admin|payroll|read-only>`
- Issue or replace a one-time password recovery key: `npm run users -- recovery-key <email>` (the key is displayed once)
- Reset a password: `npm run users -- reset-password <email>`
- Change a role: `npm run users -- set-role <email> <admin|payroll|read-only>`
- Disable an account: `npm run users -- disable <email>`
- List accounts: `npm run users -- list`

The server rate-limits sign-in attempts, stores password hashes, uses HTTP-only same-site session cookies and CSRF/origin checks, and rechecks account status and role on each request. Revealing a protected value is audited without writing the value to the audit log. Restrict database and export access; back up SQLite regularly using a safe online backup or while the service is stopped.

## Calculation scope and review

The native payroll engine implements the rules documented in the supplied Payroll Read Me: CL/EL allocation and LOP, Fixed Allowance proration by work days/calendar days, PF/EPS/EPF, sticky ESI coverage periods, bonus and gratuity estimates, and the configured income-tax slabs. TDS and statutory values are estimates and require accountant review. Do not use the portal for production payroll until the organization validates the rules, all imported records, and results against approved examples. No formula parity with the workbook is claimed.

## Project principles

- Treat payroll inputs and outputs as sensitive personal and financial data.
- Make calculations deterministic, reviewable, and reproducible.
- Use explicit validation, safe failure behavior, and auditable outcomes.
- Obtain qualified review before relying on tax, statutory, or legal calculations.
- Never commit credentials, employee records, payslips, or production exports.

## Repository layout

```text
docs/                         Architecture and engineering guidance
scripts/                      Operational and automation scripts
salary-processing/            Payroll portal UI and local-account server
salary-processing/server/      Node.js service, SQLite schema, and importer
templates/                     Reusable script design template
tests/                         Test strategy and test data guidance
```

## Security and data handling

Use synthetic data for development and testing. Keep real employee records, credentials, source workbooks, opening-balance files, exports, and database backups out of source control and test fixtures. Report security concerns privately to the repository maintainers rather than opening a public issue.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before contributing.
