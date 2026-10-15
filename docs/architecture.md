# Architecture and domain boundaries

The payroll portal runs as one Node.js service. It owns local account authentication, role checks, browser APIs, payroll calculations, and SQLite persistence. The SQLite database stores both portal accounts and payroll records. An Excel workbook is read only by the one-time migration command; the running portal does not connect to Google Sheets or any external payroll data service.

## Components

1. **Entry points** — `server.js` starts the web service; the account-management and workbook-import scripts parse CLI arguments and map failures to process exit codes.
2. **Application services** — coordinate payroll preview, period archive/rollover, register reads, and ESI review.
3. **Domain rules** — `lib/payroll.js` contains deterministic leave allocation, salary, contribution, bonus, gratuity, and tax-estimate calculations.
4. **Adapters** — SQLite is accessed through `better-sqlite3`; ExcelJS is used only by the one-time `.xlsx` importer.

Keep payroll calculations independent of HTTP and database libraries. Validate imported records before a transaction writes them. Do not log employee or payroll values.

## Hosting and persistence

- Use local email/password accounts with roles `admin`, `payroll`, and `read-only`. Recheck account status and authorization on every request; UI hiding/disablement is not an authorization boundary.
- Keep the SQLite database on the portal server's persistent local disk and run one Node process. Do not place a live database on a shared network drive.
- Put the service behind the organization's HTTPS reverse proxy. Configure the exact `APP_ORIGIN` and trust only the known proxy.
- SQLite suits one server and light-to-moderate writes. Migrate to a database service such as PostgreSQL if multiple app servers or heavier concurrent writes are required.
- Keep source workbooks, opening-balance CSVs, database files, backups, and exports outside source control and restrict their filesystem access.

## Payroll safeguards and limitations

- Make rules explicit and calculations deterministic; apply rounding at documented calculation boundaries.
- Validate source records and reject missing required workbook values rather than silently substituting data.
- Record archived payroll by period and prevent duplicate archive writes.
- Keep preview separate from archive and payment; the portal does not transfer money.
- TDS, tax, and statutory figures are estimates until validated by the organization's accountant and legal advisers.
- Historical months absent from the imported workbook are not reconstructed. Preserve imported history as supplied and validate the migration before production use.
