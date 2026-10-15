(() => {
    'use strict';

    const appShell = document.getElementById('app-shell');
    const loginGate = document.getElementById('login-gate');
    const loginButton = document.getElementById('google-login');
    const loginMessage = document.getElementById('login-message');
    const loginError = document.getElementById('login-error');
    const googleRun = typeof google !== 'undefined' && google.script && google.script.run;

    function showLoginError(error) {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.disabled = false;
        loginButton.textContent = 'Try Google account access again';
        loginMessage.textContent = 'Access could not be verified. Sign in with a Google account that has permission to open the payroll spreadsheet, then try again.';
        loginError.textContent = error?.message || 'The portal could not load authorized payroll data. Ask the spreadsheet owner to check access and setup; no employee data was loaded.';
        loginError.hidden = false;
    }

    function initialize(source) {
        if (!source || source.mode !== 'google-sheets'
            || !Array.isArray(source.companies) || !Array.isArray(source.employees)) {
            showLoginError(new Error('The portal did not return verified Google Sheets data. No payroll data was loaded.'));
            return;
        }
        appShell.hidden = false;
        loginGate.hidden = true;

    const isConnected = true;
    const companies = source.companies.map((company) => ({ ...company }));
    let employees = source.employees.map((employee) => ({ ...employee }));
    let payrollRuns = source.payrollRuns.map((run) => ({ ...run, employeeIds: [...run.employeeIds] }));
    const leaveRequests = source.leaveRequests.map((request) => ({ ...request }));
    const selectedIds = new Set();
    const companyById = new Map(companies.map((company) => [company.id, company]));
    const colors = ['#eeeafd', '#e4f3ed', '#fff0e2', '#e8effc', '#f9e9ee', '#f0eafa', '#e5f3f4', '#fff2df'];
    const registerTabs = [
        'Company Master',
        'Employee Master - FA',
        'Employee Master - FR',
        'Employee Master - SA',
        'Leave Master',
        'Attendance',
        'Advance & Loan',
        'Flavors India - Active',
        'Flavors India - Retainers',
        'Supreme Aromatics - Retainers',
        'Salary Register',
        'PF Register - Flavors India',
        'PF Register - Supreme Aromatics',
        'ESI Register',
        'Bonus Register',
        'Gratuity Register',
        'TDS Register',
        'Payslip',
        'Payroll History',
        'Reports',
        'ESI Verification Checklist'
    ];
    let currentRegisterPage = null;
    let currentRegisterStart = 5;
    let registerLoading = false;
    let editingId = null;
    let filteredPayrollEmployees = [];
    let filteredDirectoryEmployees = [];

    const byId = (id) => document.getElementById(id);
    const money = (amount) => new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0
    }).format(amount);
    const staffType = (employee) => employee.staffType || (employee.ageAtJoining >= 58 ? 'retainer' : 'active');
    const staffLabel = (employee) => staffType(employee) === 'retainer' ? 'Retainer' : 'Active';
    const companyName = (id) => companyById.get(id)?.name ?? 'Unassigned company';
    const employeeFor = (id) => employees.find((employee) => employee.id === id);
    const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join('');

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function cell(row, text, className) {
        const element = node('td', className, text);
        row.append(element);
        return element;
    }

    function avatar(employee, className = 'person-avatar') {
        const element = node('span', className, employee.initials || initials(employee.name));
        element.style.backgroundColor = employee.color || colors[employees.indexOf(employee) % colors.length];
        return element;
    }

    function personCell(employee) {
        const wrapper = node('div', 'person-cell');
        const identity = node('span', 'person-identity');
        identity.append(node('strong', '', employee.name), node('small', '', employee.id));
        wrapper.append(avatar(employee), identity);
        return wrapper;
    }

    function tag(label, style) {
        return node('span', `status-tag ${style}`, label);
    }

    function fillCompanyOptions(select, includeAll = true) {
        const firstOption = includeAll ? select.querySelector('option') : null;
        select.replaceChildren();
        if (includeAll) {
            select.append(new Option(firstOption?.textContent || 'All companies', 'all'));
        }
        companies.forEach((company) => select.append(new Option(company.name, company.id)));
    }

    function updateCompanyFilters() {
        ['employee-company-filter', 'payroll-company-filter', 'attendance-company-filter'].forEach((id) => {
            const select = byId(id);
            const value = select.value;
            fillCompanyOptions(select);
            if ([...select.options].some((option) => option.value === value)) select.value = value;
        });
        const formSelect = byId('form-company');
        const selected = formSelect.value;
        fillCompanyOptions(formSelect, false);
        if ([...formSelect.options].some((option) => option.value === selected)) formSelect.value = selected;
    }

    function renderCompanyCards() {
        const container = byId('dashboard-companies');
        container.replaceChildren();
        companies.forEach((company, index) => {
            const staff = employees.filter((employee) => employee.companyId === company.id);
            const summary = source.companyTotals?.find((item) => item.companyId === company.id);
            const pay = summary ? summary.grossSalary : staff.reduce((sum, employee) => sum + employee.baseSalary, 0);
            const card = node('article', `company-card company-color-${index % 2}`);
            const marker = node('span', 'company-marker', company.shortName.slice(0, 1));
            const details = node('span', 'company-card-details');
            details.append(node('strong', '', company.name), node('small', '', `${staff.length} employees · ${pay == null ? 'Review source formulas' : money(pay)} gross payroll`));
            card.append(marker, details, node('span', 'company-card-arrow', '↗'));
            container.append(card);
        });
    }

    function renderDashboard() {
        const totalPay = source.companyTotals
            ? source.companyTotals.reduce((sum, company) => sum + (company.grossSalary || 0), 0)
            : employees.reduce((sum, employee) => sum + employee.baseSalary, 0);
        const totalsNeedReview = source.companyTotals?.some((company) => company.grossSalary == null);
        const activeCount = employees.filter((employee) => staffType(employee) === 'active').length;
        const retainerCount = employees.length - activeCount;
        const workDays = employees.reduce((sum, employee) => sum + (employee.attendance?.workDays ?? employee.presentDays ?? 0), 0);
        const monthInput = source.payrollPeriod || '2026-10';
        const [year, month] = monthInput.split('-').map(Number);
        const period = year && month
            ? new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)))
            : source.periodLabel || 'Current period';
        byId('metric-employees').textContent = employees.length;
        byId('metric-active').textContent = activeCount;
        byId('metric-retainer').textContent = retainerCount;
        byId('metric-pay').textContent = totalsNeedReview
            ? 'Review source'
            : money(totalPay);
        byId('metric-runs').textContent = payrollRuns.length;
        byId('metric-attendance').textContent = String(workDays);
        byId('top-period').textContent = period;
        byId('pay-period').value = monthInput;
        document.querySelector('.chart-foot > span').textContent = `${period} · INR`;
        document.querySelector('.metric-card:nth-child(2) .metric-top > span').textContent = 'MONTHLY GROSS PAY';
        document.querySelector('.metric-card:nth-child(2) small').textContent = 'From the source Salary Register';
        document.querySelector('.metric-card:nth-child(4) .metric-top > span').textContent = 'REPORTED WORK DAYS';
        document.querySelector('.metric-card:nth-child(4) small').textContent = 'Reported in the current Attendance sheet';
        byId('employee-nav-count').textContent = employees.length;
        if (isConnected) {
            document.querySelector('#view-employees thead th:nth-child(4)').textContent = 'AGE AT JOINING';
            document.querySelector('#view-payroll thead th:nth-child(4)').textContent = 'AGE AT JOINING';
            byId('workspace-status').textContent = 'Google account verified';
            byId('logout-button').hidden = false;
            byId('account-button').textContent = initials(source.userEmail || 'Google');
            byId('account-button').title = 'Sign out of the portal; your Google account remains signed in';
            byId('account-button').setAttribute('aria-label', 'Sign out of Employees Pay Roll');
            byId('logout-button').title = 'Signs out of this portal only, not your Google account';
            document.querySelector('.profile-name strong').textContent = source.userEmail || 'Google account';
            document.querySelector('.profile-name small').textContent =
                source.canRevealSensitive ? 'Portal administrator' : 'Authorized account';
            document.querySelector('.profile-avatar').textContent = initials(source.userEmail || 'Google');
            document.querySelector('.profile-more').hidden = true;
            document.querySelector('#view-dashboard .welcome-row h1').textContent = 'Payroll overview';
            document.querySelector('#view-dashboard .welcome-row .eyebrow').textContent = 'CURRENT PAYROLL PERIOD · WORKSPACE OVERVIEW';
            document.querySelector('.quick-actions #quick-add-employee').hidden = true;
            document.querySelector('.quick-actions [data-go="attendance"] small').textContent = 'Review current workbook attendance inputs';
            document.querySelector('#view-dashboard .metric-card:nth-child(3) small').textContent = 'Archived payroll groups from workbook history';
            document.querySelector('#view-dashboard .payroll-overview .panel-title-row p').textContent = 'Current gross salary by company';
            document.querySelector('#view-dashboard .chart-caption').lastChild.textContent = ' Gross salary';
            document.querySelector('#view-dashboard .recent-panel .panel-title-row p').textContent =
                'Archived payroll history from the source workbook';
            document.querySelector('#view-dashboard .notice-bar span:nth-child(2)').textContent =
                'Connected to your authorized Google Sheet. Payroll previews use its calculated Salary Register; no bank payments are initiated.';
            document.querySelector('#view-employees .subheading').textContent =
                'Employee records loaded from the protected Google Sheet. Sensitive identifiers and bank/contact fields are masked; full values require configured administrator access.';
            document.querySelector('#view-payroll .subheading').textContent = 'Select employees manually; the portal previews only their calculated source register values.';
            document.querySelector('#view-payroll .notice-bar span:nth-child(2)').textContent =
                'Source-sheet preview. Gross, deductions and net use the spreadsheet formulas for selected employees only. No payment is made.';
            document.querySelector('#view-payroll .panel-title-row .section-tag').textContent = 'SELECTED ONLY';
            document.querySelector('#view-payroll .metric-card:nth-child(3) .metric-top > span').textContent = 'SELECTED BASE PAY';
            document.querySelector('#view-payroll .metric-card:nth-child(3) small').textContent =
                'Reference only; preview uses calculated register values';
            document.querySelector('#view-payroll .runs-panel .panel-title-row p').textContent =
                'Archived payroll groups read from Payroll History';
            document.querySelector('#view-payroll .run-footer > span').textContent =
                'This prepares a selected-employee preview only. Nothing is archived or paid.';
            byId('pay-period').disabled = true;
            document.querySelector('#view-attendance .subheading').textContent = 'Monthly attendance inputs, leave balances, LOP and late-deduction calculations from the source sheet.';
            document.querySelector('#view-attendance .page-heading .section-tag').textContent = 'LIVE SHEET';
            document.querySelector('#view-attendance .notice-bar span:nth-child(2)').textContent =
                'Attendance input edits are restricted to workbook input columns; formula-driven LOP and leave calculations remain in Google Sheets.';
            document.querySelector('#view-attendance .metric-card:first-child .metric-top > span').textContent = 'REPORTED WORK DAYS';
            document.querySelector('#view-attendance .metric-card:first-child small').textContent = 'Sum of work days currently listed in the Attendance tab';
            document.querySelector('#view-attendance .metric-card:nth-child(2) .metric-top > span').textContent = 'LEAVE REQUEST INBOX';
            document.querySelector('#view-attendance .metric-card:nth-child(2) small').textContent = 'Leave approval workflow is not connected';
            document.querySelector('#view-reports .subheading').textContent = 'Review company payroll, compliance registers, and safely export the authorized records you can access.';
            document.querySelector('#view-reports .page-heading .section-tag').textContent = 'AUTHORIZED DATA';
            document.querySelector('#view-reports .notice-bar span:nth-child(2)').textContent =
                'Exports contain authorized employee and payroll data. Handle downloaded files as confidential and store them securely.';
            document.querySelector('#view-reports .report-card:first-child p').textContent =
                'Payroll summaries from the workbook’s current report registers.';
            document.querySelector('#view-reports .report-card:nth-child(2) p').textContent =
                'Authorized employee directory details and salary fields.';
            document.querySelector('#view-reports .report-card:nth-child(3) p').textContent =
                'Archived payroll history read from the source workbook.';
            document.querySelector('#view-reports .report-breakdown .panel-title-row p').textContent =
                'Payroll register totals in Indian rupees; review flagged formula errors in the source workbook.';
            document.querySelector('#view-settings .subheading').textContent = `Authenticated Google account: ${source.userEmail || 'verified'} · Source of truth: protected Google Sheet.`;
            const sourceLink = byId('source-workbook-link');
            sourceLink.href = source.sourceSpreadsheetUrl || '#';
            sourceLink.hidden = !source.sourceSpreadsheetUrl;
            const settingsPanels = document.querySelectorAll('#view-settings .settings-panel');
            settingsPanels[0].querySelector('.panel-title-row p').textContent = 'Companies represented in the authorized employee masters';
            settingsPanels[1].querySelector('.panel-title-row h2').textContent = 'Payroll source and workflow';
            settingsPanels[1].querySelector('.panel-title-row p').textContent = 'Workbook calculations remain the source of truth.';
            const ruleDescriptions = settingsPanels[1].querySelectorAll('.settings-rules dd');
            const hasJoiningAge = employees.some((employee) => Number.isInteger(employee.ageAtJoining));
            ruleDescriptions[1].textContent = hasJoiningAge
                ? 'Calculated server-side from date of birth when present; otherwise uses the employee master group'
                : 'Staff type follows the employee master; age at joining is not stored';
            ruleDescriptions[2].textContent = 'Selected employees only; gross, deductions and net use the source register';
            ruleDescriptions[3].textContent = 'Calculated by workbook formulas; verify the source sheet';
            ruleDescriptions[4].textContent = 'Employee and payroll records stay in the authorized Google Sheet; portal previews are not archived';
            ruleDescriptions[5].textContent = source.periodLabel || source.payrollPeriod || 'Not set';
            ruleDescriptions[6].textContent = String(source.calendarDays || 'Not set');
            byId('add-employee-button').hidden = true;
            document.querySelector('#view-employees .classification-note').textContent =
                hasJoiningAge
                    ? 'Age at joining is calculated server-side where date of birth is present; otherwise staff type follows the employee master group.'
                    : 'Staff type follows the employee master group; age at joining is not stored in this workbook.';
            document.querySelector('#view-employees .metric-card:nth-child(2) small').textContent = 'Classification from the employee master';
            document.querySelector('#view-employees .metric-card:nth-child(3) small').textContent = 'Classification from the employee master';
            document.querySelector('.app-footer > span:last-child').textContent = 'Google Sheets source · Amounts in INR';
            const warningBar = document.querySelector('#view-dashboard .notice-bar');
            if (source.warnings?.length) {
                const details = source.warnings.slice(0, 3).join(' ');
                const remaining = source.warnings.length > 3 ? ` ${source.warnings.length - 3} more item(s) need review.` : '';
                const warning = node('span', 'server-warning', `${source.warnings.length} source-sheet item(s) need review. ${details}${remaining}`);
                warningBar.append(warning);
            }
        }
        updateRegisterOptions();
        renderCompanyCards();
        renderChart();
        renderRecentRuns(byId('recent-runs'), 3);
        if (isConnected) loadRegisterPage('Salary Register', 5);
    }

    function renderChart() {
        const chart = byId('payroll-chart');
        chart.replaceChildren();
        const values = companies.map((company) => {
            const summary = source.companyTotals?.find((item) => item.companyId === company.id);
            return summary ? summary.grossSalary : employees.filter((employee) => employee.companyId === company.id)
                .reduce((sum, employee) => sum + employee.baseSalary, 0);
        }).filter((value) => value != null);
        const maxPay = Math.max(...values, 1);
        companies.forEach((company) => {
            const companyEmployees = employees.filter((employee) => employee.companyId === company.id);
            const summary = source.companyTotals?.find((item) => item.companyId === company.id);
            const total = summary ? summary.grossSalary : companyEmployees.reduce((sum, employee) => sum + employee.baseSalary, 0);
            const group = node('div', 'chart-group');
            const amount = node('strong', 'chart-amount', total == null ? 'Review source' : money(total));
            const bar = node('div', 'chart-bar-track');
            const fill = node('span', 'chart-bar-fill');
            fill.style.height = `${total == null ? 0 : Math.max(7, (total / maxPay) * 100)}%`;
            bar.append(fill);
            group.append(amount, bar, node('span', 'chart-company', company.shortName));
            chart.append(group);
        });
    }

    function renderRecentRuns(container, limit = Infinity) {
        container.replaceChildren();
        const rows = [...payrollRuns].slice(0, limit);
        if (!rows.length) {
            container.append(node('p', 'empty-state', isConnected
                ? 'No archived payroll history was found in the source workbook.'
                : 'No payroll previews have been prepared in this session.'));
            return;
        }
        rows.forEach((run) => {
            const line = node('div', 'activity-row');
            const icon = node('span', 'activity-icon', '₹');
            const info = node('span', 'activity-info');
            info.append(
                node('strong', '', run.id),
                node('small', '', `${run.period} · ${run.companyLabel || companyName(run.companyId)} · ${run.employeeIds.length} employees`)
            );
            line.append(icon, info, node('strong', 'activity-amount', money(run.total)), tag(run.status, 'prepared'));
            container.append(line);
        });
    }

    function renderEmployees() {
        const search = byId('employee-search').value.trim().toLowerCase();
        const company = byId('employee-company-filter').value;
        const type = byId('employee-type-filter').value;
        const status = byId('employee-status-filter').value;
        filteredDirectoryEmployees = employees.filter((employee) => {
            const searchable = `${employee.name} ${employee.id} ${employee.title} ${employee.department}`.toLowerCase();
            return (company === 'all' || employee.companyId === company)
                && (type === 'all' || staffType(employee) === type)
                && (status === 'all' || employee.status === status)
                && searchable.includes(search);
        });
        const body = byId('employee-table');
        body.replaceChildren();
        filteredDirectoryEmployees.forEach((employee) => {
            const row = node('tr');
            cell(row, '').append(personCell(employee));
            cell(row, companyName(employee.companyId), 'company-cell');
            cell(row, employee.department || staffLabel(employee));
            cell(row, Number.isInteger(employee.ageAtJoining) ? `${employee.ageAtJoining} years` : 'Not in source');
            const typeCell = cell(row, '');
            typeCell.append(tag(staffLabel(employee), staffType(employee)));
            const statusCell = cell(row, '');
            statusCell.append(tag(employee.status === 'on-leave' ? 'On leave' : 'Active', employee.status === 'on-leave' ? 'on-leave' : 'active'));
            cell(row, employee.baseSalary == null ? 'Review source' : money(employee.baseSalary), 'align-right amount-cell');
            const action = cell(row, '');
            if (isConnected) {
                const view = node('button', 'row-action', 'View');
                view.type = 'button';
                view.setAttribute('aria-label', `View ${employee.name}`);
                view.addEventListener('click', () => openEmployeeDetails(employee));
                action.append(view);
            } else {
                const edit = node('button', 'row-action', 'Edit');
                edit.type = 'button';
                edit.setAttribute('aria-label', `Edit ${employee.name}`);
                edit.addEventListener('click', () => openEmployeeDialog(employee));
                action.append(edit);
            }
            body.append(row);
        });
        byId('employee-empty').hidden = filteredDirectoryEmployees.length !== 0;
        byId('employee-result-count').textContent = `Showing ${filteredDirectoryEmployees.length} of ${employees.length} employees`;
        const activeCount = employees.filter((employee) => staffType(employee) === 'active').length;
        byId('employee-total').textContent = employees.length;
        byId('employee-active').textContent = activeCount;
        byId('employee-retainer').textContent = employees.length - activeCount;
    }

    function openEmployeeDetails(employee) {
        byId('employee-detail-title').textContent = employee.name;
        byId('employee-detail-subtitle').textContent = `${employee.id} · ${companyName(employee.companyId)}`;
        byId('employee-detail-feedback').hidden = true;
        const fields = byId('employee-detail-fields');
        fields.replaceChildren();
        const details = [
            ['Job title', employee.title || 'Not recorded'],
            ['Staff type', staffLabel(employee)],
            ['Employment status', employee.status === 'on-leave' ? 'On leave' : (employee.status === 'inactive' ? 'Inactive' : 'Active')],
            ['Joining date', employee.joiningDate || 'Not recorded'],
            ['Age at joining', Number.isInteger(employee.ageAtJoining) ? `${employee.ageAtJoining} years` : 'Not recorded in the source'],
            ['Base salary', employee.baseSalary == null ? 'Review source' : money(employee.baseSalary)],
            ['Fixed allowance', employee.fixedAllowance == null ? 'Review source' : money(employee.fixedAllowance)],
            ['Per-day rate', employee.perDayRate == null ? 'Review source' : money(employee.perDayRate)],
            ['PF applicable', employee.pfApplicable ? 'Yes' : 'No'],
            ['ESI exempt', employee.esiExempt ? 'Yes' : 'No'],
            ['Health insurance', employee.healthInsurance == null ? 'Review source' : money(employee.healthInsurance)],
            ['LIC deduction', employee.licDeduction == null ? 'Review source' : money(employee.licDeduction)],
            ['CL balance', employee.leaveBalance?.clBalance ?? 'Not recorded'],
            ['EL balance', employee.leaveBalance?.elBalance ?? 'Not recorded']
        ];
        details.forEach(([label, value]) => {
            const item = node('div', 'employee-detail-item');
            item.append(node('span', '', label), node('strong', '', value));
            fields.append(item);
        });

        const protectedFields = byId('employee-protected-fields');
        protectedFields.replaceChildren();
        const secrets = Array.isArray(employee.protectedFields) ? employee.protectedFields : [];
        if (!secrets.length) {
            protectedFields.append(node('p', 'empty-state', 'No sensitive fields were found in this employee master.'));
        }
        secrets.forEach((field) => {
            const item = node('div', 'protected-field');
            const value = node('strong', 'protected-value', field.maskedValue);
            const reveal = node('button', 'button button-light protected-reveal', source.canRevealSensitive ? 'Show value' : 'Admin access required');
            reveal.type = 'button';
            reveal.disabled = !source.canRevealSensitive;
            reveal.setAttribute('aria-label', `${source.canRevealSensitive ? 'Show' : 'Admin access required for'} ${field.label}`);
            reveal.addEventListener('click', () => {
                if (reveal.dataset.revealed === 'true') {
                    value.textContent = field.maskedValue;
                    reveal.textContent = 'Show value';
                    reveal.dataset.revealed = 'false';
                    return;
                }
                reveal.disabled = true;
                reveal.textContent = 'Checking access…';
                google.script.run
                    .withSuccessHandler((fullValue) => {
                        value.textContent = fullValue;
                        reveal.textContent = 'Hide value';
                        reveal.dataset.revealed = 'true';
                        reveal.disabled = false;
                    })
                    .withFailureHandler((error) => {
                        reveal.textContent = 'Show value';
                        reveal.disabled = false;
                        byId('employee-detail-feedback').textContent =
                            error.message || 'The protected value could not be revealed.';
                        byId('employee-detail-feedback').hidden = false;
                    })
                    .revealEmployeeSensitiveField(employee.id, field.columnNumber);
            });
            item.append(node('span', '', field.label), value, reveal);
            protectedFields.append(item);
        });
        byId('employee-detail-dialog').showModal();
    }

    function updateRegisterOptions() {
        const select = byId('register-select');
        select.replaceChildren();
        registerTabs.forEach((sheetName) => select.append(new Option(sheetName, sheetName)));
        select.value = 'Salary Register';
    }

    function loadRegisterPage(sheetName, startRow) {
        if (registerLoading) return;
        registerLoading = true;
        byId('register-title').textContent = sheetName;
        byId('register-caption').textContent = 'Loading authorized workbook data…';
        byId('register-feedback').textContent = '';
        byId('register-body').replaceChildren();
        byId('register-head').replaceChildren();
        byId('register-page-status').textContent = 'Loading register rows…';
        byId('register-previous').disabled = true;
        byId('register-next').disabled = true;
        byId('export-register').disabled = true;
        google.script.run
            .withSuccessHandler((page) => {
                currentRegisterPage = page;
                currentRegisterStart = startRow;
                renderRegisterPage(page);
                registerLoading = false;
            })
            .withFailureHandler((error) => {
                registerLoading = false;
                byId('register-caption').textContent = 'Register could not be loaded.';
                byId('register-feedback').textContent =
                    error.message || `Unable to load the ${sheetName} tab.`;
                byId('register-page-status').textContent = '';
            })
            .getPayrollRegisterPage(sheetName, startRow);
    }

    function renderRegisterPage(page) {
        const header = node('tr');
        header.append(node('th', '', 'ROW'));
        page.columns.forEach((column) => header.append(node('th', '', column || '—')));
        byId('register-head').replaceChildren(header);
        const body = byId('register-body');
        body.replaceChildren();
        page.rows.forEach((record) => {
            const row = node('tr');
            cell(row, record.rowNumber, 'register-row-number');
            record.values.forEach((value) => cell(row, value));
            body.append(row);
        });
        const firstShown = page.rows.length ? page.rows[0].rowNumber : page.startRow;
        const lastShown = page.rows.length ? page.rows[page.rows.length - 1].rowNumber : firstShown;
        byId('register-title').textContent = page.sheetName;
        byId('register-caption').textContent =
            'Source workbook values. Read-only view; sensitive columns are masked.';
        byId('register-page-status').textContent =
            `${page.rows.length ? `Rows ${firstShown}–${lastShown}` : 'No rows on this page'} · ${page.totalRows} source rows`;
        byId('register-previous').disabled = currentRegisterStart <= 5 || registerLoading;
        byId('register-next').disabled = !page.hasMore || registerLoading;
        byId('export-register').disabled = !page.rows.length;
    }

    function filteredForPayroll() {
        const company = byId('payroll-company-filter').value;
        const type = byId('payroll-type-filter').value;
        return employees.filter((employee) => employee.status !== 'inactive'
            && (company === 'all' || employee.companyId === company)
            && (type === 'all' || staffType(employee) === type));
    }

    function updatePayrollSummary() {
        const selected = employees.filter((employee) => selectedIds.has(employee.id));
        const total = selected.reduce((sum, employee) => sum + (employee.baseSalary || 0), 0);
        byId('payroll-eligible').textContent = employees.filter((employee) => employee.status === 'active').length;
        byId('payroll-selected').textContent = selected.length;
        byId('payroll-selected-total').textContent = selected.some((employee) => employee.baseSalary == null)
            ? 'Review source'
            : money(total);
        byId('payroll-selection-caption').textContent = `${selected.length} ${selected.length === 1 ? 'employee' : 'employees'} selected`;
        byId('process-payroll').disabled = selected.length === 0;
    }

    function renderPayrollSelection() {
        filteredPayrollEmployees = filteredForPayroll();
        const body = byId('payroll-table');
        body.replaceChildren();
        filteredPayrollEmployees.forEach((employee) => {
            const row = node('tr');
            const checkboxCell = cell(row, '', 'check-cell');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'payroll-checkbox';
            checkbox.checked = selectedIds.has(employee.id);
            checkbox.dataset.employeeId = employee.id;
            checkbox.setAttribute('aria-label', `Select ${employee.name} for payroll`);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedIds.add(employee.id);
                else selectedIds.delete(employee.id);
                byId('payroll-result').hidden = true;
                updatePayrollSummary();
                updateSelectAllState();
            });
            checkboxCell.append(checkbox);
            cell(row, '').append(personCell(employee));
            cell(row, companyName(employee.companyId), 'company-cell');
            cell(row, Number.isInteger(employee.ageAtJoining) ? `${employee.ageAtJoining} years` : 'Not in source');
            const staffCell = cell(row, '');
            staffCell.append(tag(staffLabel(employee), staffType(employee)));
            cell(row, employee.baseSalary == null ? 'Review source' : money(employee.baseSalary), 'align-right amount-cell');
            body.append(row);
        });
        byId('payroll-visible-count').textContent = `Showing ${filteredPayrollEmployees.length} employees`;
        byId('payroll-empty').hidden = filteredPayrollEmployees.length !== 0;
        updatePayrollSummary();
        updateSelectAllState();
    }

    function updateSelectAllState() {
        const selectedVisible = filteredPayrollEmployees.filter((employee) => selectedIds.has(employee.id)).length;
        const allSelected = filteredPayrollEmployees.length > 0 && selectedVisible === filteredPayrollEmployees.length;
        const checkbox = byId('select-all-visible');
        checkbox.checked = allSelected;
        checkbox.indeterminate = selectedVisible > 0 && !allSelected;
        byId('select-toggle').textContent = allSelected ? 'Deselect all visible' : 'Select all visible';
    }

    function renderRuns() {
        renderRecentRuns(byId('payroll-runs'));
    }

    function processPayroll() {
        const selected = employees.filter((employee) => selectedIds.has(employee.id) && employee.status !== 'inactive');
        if (!selected.length) return;
        const period = byId('pay-period').value;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
            const result = byId('payroll-result');
            result.textContent = 'Choose a valid payroll period before preparing a preview.';
            result.hidden = false;
            return;
        }
        const button = byId('process-payroll');
        button.disabled = true;
        button.textContent = 'Checking selected employees…';
        google.script.run
            .withSuccessHandler(showConnectedPreview)
            .withFailureHandler((error) => {
                button.textContent = 'Prepare payroll preview →';
                button.disabled = selectedIds.size === 0;
                const result = byId('payroll-result');
                result.textContent = error.message || 'The source payroll preview failed. Check the Google Sheet and try again.';
                result.hidden = false;
            })
            .getSelectedPayrollPreview(selected.map((employee) => employee.id), period);
        return;
    }

    function showConnectedPreview(rows) {
        const result = byId('payroll-result');
        const gross = rows.reduce((sum, employee) => sum + employee.grossSalary, 0);
        const deductions = rows.reduce((sum, employee) => sum + employee.totalDeductions, 0);
        const net = rows.reduce((sum, employee) => sum + employee.netPayable, 0);
        const heading = node('strong', '', `${rows.length} selected ${rows.length === 1 ? 'employee' : 'employees'} · source-sheet preview`);
        result.replaceChildren(
            heading,
            document.createTextNode(` · Gross ${money(gross)} · Deductions ${money(deductions)} · Net payable ${money(net)}. Preview only; nothing has been archived or paid.`)
        );
        rows.forEach((employee) => {
            const detail = node('span', 'preview-detail',
                `${employee.employeeId} · ${employee.name} · Gross ${money(employee.grossSalary)} · Deductions ${money(employee.totalDeductions)} · Net ${money(employee.netPayable)}`);
            result.append(detail);
        });
        result.hidden = false;
        selectedIds.clear();
        byId('process-payroll').textContent = 'Prepare payroll preview →';
        renderPayrollSelection();
    }

    function renderAttendance() {
        const company = byId('attendance-company-filter').value;
        const subset = employees.filter((employee) => company === 'all' || employee.companyId === company);
        const body = byId('attendance-table');
        body.replaceChildren();
        subset.forEach((employee) => {
            const row = node('tr');
            cell(row, '').append(personCell(employee));
            cell(row, companyName(employee.companyId), 'company-cell');
            const attendance = employee.attendance || {
                workDays: employee.presentDays ?? 0,
                leaveDays: employee.workingDays ? Math.max(0, employee.workingDays - employee.presentDays) : 0,
                longestContinuousSpell: 0,
                lopDays: 0,
                lopAmount: 0,
                processAllowance: 0,
                punctualIncentive: 0,
                fullAttendanceBonus: 0,
                totalLateDays: 0,
                lateAttendanceDeduction: 0
            };
            const inputFields = [
                ['workDays', attendance.workDays, false],
                ['leaveDays', attendance.leaveDays, false],
                ['longestContinuousSpell', attendance.longestContinuousSpell, false]
            ];
            inputFields.forEach(([field, value]) => appendAttendanceInput(row, employee, field, value, false));
            cell(row, attendance.lopDays ?? 0, 'align-right');
            cell(row, attendance.lopAmount == null ? 'Check sheet' : money(attendance.lopAmount), 'align-right amount-cell');
            [
                ['processAllowance', attendance.processAllowance, true],
                ['punctualIncentive', attendance.punctualIncentive, true],
                ['fullAttendanceBonus', attendance.fullAttendanceBonus, true],
                ['totalLateDays', attendance.totalLateDays, false]
            ].forEach(([field, value, isMoney]) => appendAttendanceInput(row, employee, field, value, isMoney));
            cell(row, attendance.lateAttendanceDeduction == null ? 'Check sheet' : money(attendance.lateAttendanceDeduction), 'align-right amount-cell');
            const actionCell = cell(row, '');
            const action = node('div', 'attendance-action');
            const save = node('button', 'attendance-save', 'Save');
            save.type = 'button';
            save.addEventListener('click', () => saveAttendance(employee, row, save));
            action.append(save);
            actionCell.append(action);
            body.append(row);
        });
        const reportedWorkDays = employees.reduce((sum, employee) =>
            sum + (employee.attendance?.workDays ?? employee.presentDays ?? 0), 0);
        byId('attendance-average').textContent = String(reportedWorkDays);
        byId('leave-pending').textContent = leaveRequests.filter((request) => request.status === 'Pending').length;
        byId('leave-used').textContent = isConnected
            ? employees.reduce((sum, employee) => sum + (employee.leaveBalance?.clTaken || 0) + (employee.leaveBalance?.elTaken || 0), 0)
            : employees.reduce((sum, employee) => sum + employee.leaveUsed, 0);
        renderLeaveRequests();
    }

    function appendAttendanceInput(row, employee, field, value, isMoney) {
        const input = document.createElement('input');
        input.className = `attendance-input${isMoney ? ' money-input' : ''}`;
        input.type = 'number';
        input.min = '0';
        input.max = isMoney ? '10000000' : String(source.calendarDays || 31);
        input.step = '1';
        input.value = value == null ? '' : String(value);
        input.dataset.field = field;
        input.setAttribute('aria-label', `${field} for ${employee.name}`);
        cell(row, '').append(input);
    }

    function saveAttendance(employee, row, button) {
        const fields = {};
        row.querySelectorAll('.attendance-input').forEach((input) => {
            fields[input.dataset.field] = input.value;
        });
        button.disabled = true;
        button.textContent = 'Saving';
        if (isConnected) {
            google.script.run
                .withSuccessHandler(() => {
                    button.textContent = 'Saved';
                    button.classList.add('saved');
                    window.setTimeout(() => window.location.reload(), 500);
                })
                .withFailureHandler((error) => {
                    button.disabled = false;
                    button.textContent = 'Save';
                    const feedback = node('span', 'attendance-feedback', error.message || 'Attendance update failed. Check sheet access and try again.');
                    row.querySelector('.attendance-action').append(feedback);
                })
                .updateAttendance(employee.id, fields);
            return;
        }
        employee.attendance = { ...(employee.attendance || {}), ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [key, Number(value)])
        ) };
        button.disabled = false;
        button.textContent = 'Saved';
        window.setTimeout(() => {
            button.textContent = 'Save';
            button.classList.remove('saved');
        }, 1200);
        renderDashboard();
    }

    function renderLeaveRequests() {
        const list = byId('leave-list');
        list.replaceChildren();
        if (isConnected) {
            employees.forEach((employee) => {
                const balance = employee.leaveBalance;
                if (!balance) return;
                const row = node('div', 'leave-row');
                const info = node('div', 'leave-info');
                info.append(
                    node('strong', '', employee.name),
                    node('small', '', `${employee.id} · CL: ${balance.clTaken}/${balance.clEntitlement} used (${balance.clBalance} left) · EL: ${balance.elTaken}/${balance.elEntitlement} used (${balance.elBalance} left)`)
                );
                row.append(avatar(employee), info, tag(staffLabel(employee), staffType(employee)));
                list.append(row);
            });
            return;
        }
        leaveRequests.forEach((request) => {
            const employee = employeeFor(request.employeeId);
            if (!employee) return;
            const row = node('div', 'leave-row');
            const info = node('div', 'leave-info');
            info.append(node('strong', '', employee.name), node('small', '', `${request.type} · ${request.startDate} to ${request.endDate} · ${request.days} ${request.days === 1 ? 'day' : 'days'}`));
            row.append(avatar(employee), info, tag(request.status, request.status === 'Pending' ? 'pending' : 'prepared'));
            if (request.status === 'Pending') {
                const approve = node('button', 'row-action', 'Approve');
                approve.type = 'button';
                approve.addEventListener('click', () => {
                    request.status = 'Approved';
                    renderLeaveRequests();
                    byId('leave-pending').textContent = leaveRequests.filter((item) => item.status === 'Pending').length;
                });
                row.append(approve);
            }
            list.append(row);
        });
    }

    function renderReports() {
        const container = byId('company-summary');
        container.replaceChildren();
        if (Array.isArray(source.companyReports) && source.companyReports.length) {
            source.companyReports.forEach((report) => {
                const row = node('div', 'summary-line report-summary-line');
                const details = node('span', 'report-summary-values');
                details.append(
                    node('span', '', `Gross ${report.grossSalary == null ? 'Review' : money(report.grossSalary)}`),
                    node('span', '', `PF ${report.employeePf == null ? 'Review' : money(report.employeePf)}`),
                    node('span', '', `ESI ${report.employeeEsi == null ? 'Review' : money(report.employeeEsi)}`),
                    node('span', '', `Deductions ${report.totalDeductions == null ? 'Review' : money(report.totalDeductions)}`),
                    node('span', '', `Net ${report.netPayable == null ? 'Review' : money(report.netPayable)}`)
                );
                row.append(node('strong', '', report.companyLabel), node('span', '', `${report.employees ?? 0} employees`), details);
                container.append(row);
            });
            return;
        }
        companies.forEach((company) => {
            const group = employees.filter((employee) => employee.companyId === company.id);
            const summary = source.companyTotals?.find((item) => item.companyId === company.id);
            const total = summary ? summary.grossSalary : group.reduce((sum, employee) => sum + employee.baseSalary, 0);
            const row = node('div', 'summary-line');
            row.append(
                node('strong', '', company.name),
                node('span', '', `${group.length} employees`),
                node('strong', 'summary-line-amount', total == null ? 'Review source formulas' : money(total))
            );
            container.append(row);
        });
    }

    function renderSettings() {
        const container = byId('settings-companies');
        container.replaceChildren();
        companies.forEach((company, index) => {
            const staff = employees.filter((employee) => employee.companyId === company.id);
            const row = node('div', 'settings-company');
            row.append(
                node('span', `company-marker company-color-${index % 2}`, company.shortName[0]),
                node('strong', '', company.name),
                node('span', 'settings-company-count', `${staff.length} employees in source sheet`)
            );
            container.append(row);
        });
        byId('setting-pay-period').textContent = source.periodLabel || source.payrollPeriod || 'Not set';
        byId('setting-calendar-days').textContent = source.calendarDays || 'Not set';
    }

    function exportCsv(filename, headers, rows) {
        const escape = (value) => {
            let text = String(value ?? '');
            if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replaceAll('"', '""')}"`;
        };
        const content = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
        const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }

    function employeeCsvRows(list) {
        return list.map((employee) => [
            employee.id, employee.name, companyName(employee.companyId), employee.department,
            employee.title, employee.ageAtJoining, staffLabel(employee), employee.status,
            employee.joiningDate, employee.baseSalary
        ]);
    }

    function openEmployeeDialog(employee = null) {
        const form = byId('employee-form');
        form.reset();
        byId('form-error').hidden = true;
        editingId = employee?.id ?? null;
        byId('dialog-title').textContent = employee ? 'Edit employee' : 'Add employee';
        byId('form-original-id').value = employee?.id ?? '';
        byId('form-id').value = employee?.id ?? '';
        byId('form-id').readOnly = Boolean(employee);
        byId('form-name').value = employee?.name ?? '';
        byId('form-company').value = employee?.companyId ?? companies[0]?.id ?? '';
        byId('form-department').value = employee?.department ?? '';
        byId('form-title').value = employee?.title ?? '';
        byId('form-age').value = employee?.ageAtJoining ?? '';
        byId('form-join-date').value = employee?.joiningDate ?? '';
        byId('form-salary').value = employee?.baseSalary ?? '';
        byId('form-status').value = employee?.status ?? 'active';
        byId('employee-dialog').showModal();
    }

    function saveEmployee(event) {
        event.preventDefault();
        const id = byId('form-id').value.trim();
        const existing = editingId ? employeeFor(editingId) : null;
        if (!existing && employees.some((employee) => employee.id.toLowerCase() === id.toLowerCase())) {
            byId('form-error').textContent = 'That employee ID is already in use. Choose a unique ID.';
            byId('form-error').hidden = false;
            return;
        }
        const name = byId('form-name').value.trim();
        const ageAtJoining = Number(byId('form-age').value);
        const baseSalary = Number(byId('form-salary').value);
        if (!Number.isSafeInteger(baseSalary) || baseSalary <= 0 || !Number.isInteger(ageAtJoining) || ageAtJoining < 18 || ageAtJoining > 100) {
            byId('form-error').textContent = 'Enter a valid whole-rupee monthly salary and an age between 18 and 100.';
            byId('form-error').hidden = false;
            return;
        }
        const record = {
            id, name,
            companyId: byId('form-company').value,
            department: byId('form-department').value.trim(),
            title: byId('form-title').value.trim(),
            ageAtJoining,
            joiningDate: byId('form-join-date').value,
            baseSalary,
            status: byId('form-status').value,
            presentDays: existing?.presentDays ?? 0,
            workingDays: existing?.workingDays ?? 22,
            leaveUsed: existing?.leaveUsed ?? 0,
            initials: initials(name),
            color: existing?.color ?? colors[employees.length % colors.length]
        };
        if (existing) Object.assign(existing, record);
        else employees.push(record);
        byId('employee-dialog').close();
        updateCompanyFilters();
        renderAll();
    }

    function renderAll() {
        renderDashboard();
        renderEmployees();
        renderPayrollSelection();
        renderAttendance();
        renderReports();
        renderSettings();
    }

    function signOutOfPortal() {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.disabled = false;
        loginButton.textContent = 'Continue with Google';
        loginMessage.textContent = 'You have signed out of Employees Pay Roll on this device. Sign in again to reload authorized payroll data. Your Google account remains signed in to Google.';
        loginError.hidden = true;
        selectedIds.clear();
        employees = [];
        payrollRuns = [];
        ['employees', 'payrollRuns', 'companyReports', 'advances', 'leaveBalances', 'companyTotals', 'leaveRequests']
            .forEach((key) => {
                if (Array.isArray(source[key])) source[key].length = 0;
                else source[key] = null;
            });
        source.userEmail = null;
        currentRegisterPage = null;
        byId('employee-detail-dialog').close();
        document.querySelectorAll('#app-shell tbody').forEach((body) => body.replaceChildren());
        byId('payroll-result').replaceChildren();
        byId('register-head').replaceChildren();
        byId('register-body').replaceChildren();
        window.location.reload();
    }

    function showView(name) {
        document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
        document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
            const isActive = button.dataset.view === name;
            button.classList.toggle('active', isActive);
            if (isActive) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        const view = byId(`view-${name}`);
        byId('breadcrumb-current').textContent = view?.dataset.title ?? 'Overview';
        document.querySelector('.main-content').scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.querySelectorAll('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go)));
    byId('quick-add-employee').addEventListener('click', () => openEmployeeDialog());
    document.querySelectorAll('#employee-company-filter, #employee-type-filter, #employee-status-filter')
        .forEach((select) => select.addEventListener('change', renderEmployees));
    byId('employee-search').addEventListener('input', renderEmployees);
    document.querySelectorAll('#payroll-company-filter, #payroll-type-filter')
        .forEach((select) => select.addEventListener('change', renderPayrollSelection));
    byId('select-all-visible').addEventListener('change', () => {
        filteredPayrollEmployees.forEach((employee) => {
            if (byId('select-all-visible').checked) selectedIds.add(employee.id);
            else selectedIds.delete(employee.id);
        });
        byId('payroll-result').hidden = true;
        renderPayrollSelection();
    });
    byId('select-toggle').addEventListener('click', () => {
        const select = filteredPayrollEmployees.some((employee) => !selectedIds.has(employee.id));
        filteredPayrollEmployees.forEach((employee) => {
            if (select) selectedIds.add(employee.id);
            else selectedIds.delete(employee.id);
        });
        byId('payroll-result').hidden = true;
        renderPayrollSelection();
    });
    byId('process-payroll').addEventListener('click', processPayroll);
    byId('attendance-company-filter').addEventListener('change', renderAttendance);
    byId('add-employee-button').addEventListener('click', () => openEmployeeDialog());
    byId('employee-form').addEventListener('submit', saveEmployee);
    document.querySelector('.dialog-close').addEventListener('click', () => byId('employee-dialog').close());
    document.querySelector('.dialog-cancel').addEventListener('click', () => byId('employee-dialog').close());
    byId('employee-dialog').addEventListener('click', (event) => {
        if (event.target === byId('employee-dialog')) byId('employee-dialog').close();
    });
    byId('employee-detail-close').addEventListener('click', () => byId('employee-detail-dialog').close());
    byId('employee-detail-dialog').addEventListener('click', (event) => {
        if (event.target === byId('employee-detail-dialog')) byId('employee-detail-dialog').close();
    });
    byId('employee-detail-dialog').addEventListener('close', () => {
        byId('employee-detail-fields').replaceChildren();
        byId('employee-protected-fields').replaceChildren();
        byId('employee-detail-feedback').hidden = true;
    });
    byId('logout-button').addEventListener('click', signOutOfPortal);
    byId('account-button').addEventListener('click', () => {
        if (isConnected) signOutOfPortal();
    });
    byId('register-select').addEventListener('change', () => loadRegisterPage(byId('register-select').value, 5));
    byId('register-next').addEventListener('click', () => {
        if (currentRegisterPage?.hasMore) loadRegisterPage(currentRegisterPage.sheetName, currentRegisterPage.nextStartRow);
    });
    byId('register-previous').addEventListener('click', () => {
        loadRegisterPage(currentRegisterPage?.sheetName || byId('register-select').value, Math.max(5, currentRegisterStart - 100));
    });
    byId('export-register').addEventListener('click', () => {
        if (!currentRegisterPage?.rows.length) return;
        exportCsv(`employees-pay-roll-${currentRegisterPage.sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-page.csv`,
            ['Source row', ...currentRegisterPage.columns],
            currentRegisterPage.rows.map((record) => [record.rowNumber, ...record.values]));
    });
    document.querySelector('.notice-close').addEventListener('click', (event) => event.currentTarget.closest('.notice-bar').remove());
    byId('export-employees').addEventListener('click', () => exportCsv('employees-pay-roll-employee-directory-authorized.csv',
        ['Employee ID', 'Name', 'Company', 'Department', 'Job title', 'Age at joining', 'Staff type', 'Status', 'Joining date', 'Monthly base salary INR'],
        employeeCsvRows(filteredDirectoryEmployees)));
    byId('export-directory-report').addEventListener('click', () => exportCsv('employees-pay-roll-employee-directory-authorized.csv',
        ['Employee ID', 'Name', 'Company', 'Department', 'Job title', 'Age at joining', 'Staff type', 'Status', 'Joining date', 'Monthly base salary INR'],
        employeeCsvRows(employees)));
    byId('export-salary-report').addEventListener('click', () => exportCsv(
        'employees-pay-roll-salary-summary-authorized.csv',
        ['Company group', 'Employee count', 'Gross salary INR', 'Employee PF INR', 'Employee ESI INR', 'Total deductions INR', 'Net payable INR', 'Annual bonus estimate INR', 'Gratuity estimate INR', 'Annual TDS estimate INR'],
        source.companyReports.map((report) => [report.companyLabel, report.employees, report.grossSalary, report.employeePf, report.employeeEsi, report.totalDeductions, report.netPayable, report.annualBonus, report.gratuityEstimate, report.annualTds])));
    byId('export-runs-report').addEventListener('click', () => exportCsv('employees-pay-roll-payroll-runs-authorized.csv',
        ['Run ID', 'Period', 'Company', 'Employee count', 'Base salary total INR', 'Status', 'Prepared date'],
        payrollRuns.map((run) => [run.id, run.period, run.companyLabel || companyName(run.companyId), run.employeeIds.length, run.total, run.status, run.createdAt])));
    byId('pay-period').addEventListener('change', () => {
        const [year, month] = byId('pay-period').value.split('-').map(Number);
        if (year && month) byId('top-period').textContent = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
    });

    updateCompanyFilters();
    renderAll();
    }

    if (googleRun) {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.addEventListener('click', () => {
            loginButton.disabled = true;
            loginButton.textContent = 'Verifying Google account…';
            loginError.hidden = true;
            google.script.run
                .withSuccessHandler(initialize)
                .withFailureHandler(showLoginError)
                .getPortalData();
        });
    } else {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.hidden = true;
        loginMessage.textContent = 'Live payroll data is available only from the deployed Google Apps Script portal. This local page does not include employee records.';
        loginError.hidden = true;
    }
})();
