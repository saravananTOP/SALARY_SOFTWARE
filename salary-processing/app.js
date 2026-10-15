(() => {
    'use strict';

    const appShell = document.getElementById('app-shell');
    const loginGate = document.getElementById('login-gate');
    const loginForm = document.getElementById('login-form');
    const loginButton = document.getElementById('login-button');
    const loginMessage = document.getElementById('login-message');
    const loginError = document.getElementById('login-error');
    let csrfToken = null;

    async function apiRequest(url, options = {}) {
        const method = options.method || 'GET';
        const headers = { ...(options.headers || {}) };
        if (options.body !== undefined && !(options.body instanceof Blob)
            && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
        }
        if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
        const response = await fetch(url, {
            ...options,
            method,
            headers,
            credentials: 'same-origin'
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'The portal request failed.');
        return body;
    }

    function showLoginError(error) {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.disabled = false;
        loginButton.textContent = 'Sign in';
        loginMessage.textContent = 'Use the local account provided by your payroll portal administrator.';
        loginError.textContent = error?.message || 'The portal could not load payroll data. No employee data was displayed.';
        loginError.hidden = false;
    }

    function initialize(source) {
        if (!source || source.mode !== 'sqlite'
            || !Array.isArray(source.companies) || !Array.isArray(source.employees)) {
            showLoginError(new Error('The portal did not return valid payroll data. No employee data was displayed.'));
            return;
        }
        appShell.hidden = false;
        loginGate.hidden = true;
        loginError.hidden = true;

    const isConnected = true;
    const companies = source.companies.map((company) => ({ ...company }));
    let employees = source.employees.map((employee) => ({ ...employee }));
    let payrollRuns = source.payrollRuns.map((run) => ({ ...run, employeeIds: [...run.employeeIds] }));
    const leaveRequests = source.leaveRequests.map((request) => ({ ...request }));
    const selectedIds = new Set();
    const companyById = new Map(companies.map((company) => [company.id, company]));
    const colors = ['#eeeafd', '#e4f3ed', '#fff0e2', '#e8effc', '#f9e9ee', '#f0eafa', '#e5f3f4', '#fff2df'];
    const registerNames = [
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
    let fixedDataEmployeeId = null;
    let attendancePreviewRows = null;
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
        ['employee-company-filter', 'payroll-company-filter', 'attendance-company-filter', 'data-review-company'].forEach((id) => {
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
            const pay = summary ? summary.grossSalary : staff.some((employee) => employee.baseSalary == null)
                ? null
                : staff.reduce((sum, employee) => sum + employee.baseSalary, 0);
            const card = node('article', `company-card company-color-${index % 2}`);
            const marker = node('span', 'company-marker', company.shortName.slice(0, 1));
            const details = node('span', 'company-card-details');
            details.append(node('strong', '', company.name), node('small', '', `${staff.length} employees · ${pay == null ? 'Review source data before payroll' : `${money(pay)} gross payroll`}`));
            card.append(marker, details, node('span', 'company-card-arrow', '↗'));
            container.append(card);
        });
    }

    function renderDashboard() {
        const totalPay = source.companyTotals
            ? source.companyTotals.reduce((sum, company) => sum + (company.grossSalary || 0), 0)
            : employees.some((employee) => employee.baseSalary == null)
                ? 0
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
        byId('metric-pay').classList.toggle('metric-value-review', Boolean(totalsNeedReview));
        byId('metric-runs').textContent = payrollRuns.length;
        byId('metric-attendance').textContent = String(workDays);
        byId('top-period').textContent = period;
        byId('pay-period').value = monthInput;
        document.querySelector('.chart-foot > span').textContent = `${period} · INR`;
        document.querySelector('.metric-card:nth-child(2) .metric-top > span').textContent = 'MONTHLY GROSS PAY';
        document.querySelector('.metric-card:nth-child(2) small').textContent = 'Calculated from current payroll inputs';
        document.querySelector('.metric-card:nth-child(4) .metric-top > span').textContent = 'REPORTED WORK DAYS';
        document.querySelector('.metric-card:nth-child(4) small').textContent = 'Reported in current-period portal attendance';
        byId('employee-nav-count').textContent = employees.length;
        if (isConnected) {
            document.querySelector('#view-employees thead th:nth-child(4)').textContent = 'AGE AT JOINING';
            document.querySelector('#view-payroll thead th:nth-child(4)').textContent = 'AGE AT JOINING';
            byId('workspace-status').textContent = 'Local account signed in';
            byId('logout-button').hidden = false;
            byId('account-button').textContent = initials(source.userEmail || 'User');
            byId('account-button').title = 'Sign out of the payroll portal';
            byId('account-button').setAttribute('aria-label', 'Sign out of Employees Pay Roll');
            byId('logout-button').title = 'Signs out of the payroll portal';
            byId('profile-email').textContent = source.userEmail || 'Portal account';
            document.querySelector('.profile-name small').textContent = ({
                admin: 'Portal administrator',
                payroll: 'Payroll user',
                'read-only': 'Read-only user'
            })[source.userRole] || 'Local account';
            document.querySelector('.profile-avatar').textContent = initials(source.userEmail || 'User');
            document.querySelector('.profile-more').hidden = true;
            document.querySelector('#view-dashboard .welcome-row h1').textContent = 'Payroll overview';
            document.querySelector('#view-dashboard .welcome-row .eyebrow').textContent = 'CURRENT PAYROLL PERIOD · WORKSPACE OVERVIEW';
            document.querySelector('.quick-actions #quick-add-employee').hidden = true;
            byId('data-review-nav').hidden = !source.canManageEmployeeData;
            byId('quick-review-source-data').hidden = !source.canManageEmployeeData || !source.dataReview?.pendingCount;
            document.querySelector('.quick-actions [data-go="attendance"] small').textContent = 'Review current payroll-period inputs';
            document.querySelector('#view-dashboard .metric-card:nth-child(3) small').textContent = 'Archived payroll runs stored in SQLite';
            document.querySelector('#view-dashboard .payroll-overview .panel-title-row p').textContent = 'Current gross salary by company';
            document.querySelector('#view-dashboard .chart-caption').lastChild.textContent = ' Gross salary';
            document.querySelector('#view-dashboard .recent-panel .panel-title-row p').textContent =
                'Archived payroll history stored in SQLite';
            document.querySelector('#view-dashboard .notice-bar span:nth-child(2)').textContent =
                'Payroll records and calculations are stored locally in SQLite. Payroll previews do not initiate payments.';
            document.querySelector('#view-employees .subheading').textContent =
                'Employee records are stored in the portal database. Sensitive identifiers are masked; full values require administrator access.';
            document.querySelector('#view-payroll .subheading').textContent = 'Select employees manually to calculate a local payroll preview.';
            document.querySelector('#view-payroll .notice-bar span:nth-child(2)').textContent =
                'Gross, deductions and net are calculated from the approved payroll rules for selected employees. No payment is made.';
            document.querySelector('#view-payroll .panel-title-row .section-tag').textContent = 'SELECTED ONLY';
            document.querySelector('#view-payroll .metric-card:nth-child(3) .metric-top > span').textContent = 'SELECTED BASE PAY';
            document.querySelector('#view-payroll .metric-card:nth-child(3) small').textContent =
                'Reference amount for the selected employees';
            document.querySelector('#view-payroll .runs-panel .panel-title-row p').textContent =
                'Archived payroll groups from SQLite history';
            document.querySelector('#view-payroll .run-footer > span').textContent =
                'This prepares a selected-employee preview only. Nothing is archived or paid.';
            byId('pay-period').disabled = true;
            document.querySelector('#view-attendance .subheading').textContent = 'Monthly attendance inputs, leave balances and locally calculated loss of pay.';
            document.querySelector('#view-attendance .page-heading .section-tag').textContent = 'SQLITE';
            document.querySelector('#view-attendance .notice-bar span:nth-child(2)').textContent =
                'Update only the monthly inputs documented in the payroll Read Me. Leave usage and loss of pay are calculated in the portal.';
            document.querySelector('#view-attendance .metric-card:first-child .metric-top > span').textContent = 'REPORTED WORK DAYS';
            document.querySelector('#view-attendance .metric-card:first-child small').textContent = 'Sum of work days currently listed in the Attendance tab';
            document.querySelector('#view-attendance .metric-card:nth-child(2) .metric-top > span').textContent = 'LEAVE REQUEST INBOX';
            document.querySelector('#view-attendance .metric-card:nth-child(2) small').textContent = 'Leave approval workflow is not connected';
            document.querySelector('#view-reports .subheading').textContent = 'Review company payroll, compliance registers, and safely export the authorized records you can access.';
            document.querySelector('#view-reports .page-heading .section-tag').textContent = 'AUTHORIZED DATA';
            document.querySelector('#view-reports .notice-bar span:nth-child(2)').textContent =
                'Exports contain authorized employee and payroll data. Handle downloaded files as confidential and store them securely.';
            document.querySelector('#view-reports .report-card:first-child p').textContent =
                'Payroll summaries calculated from local payroll data.';
            document.querySelector('#view-reports .report-card:nth-child(2) p').textContent =
                'Authorized employee directory details and salary fields.';
            document.querySelector('#view-reports .report-card:nth-child(3) p').textContent =
                'Archived payroll history stored in SQLite.';
            document.querySelector('#view-reports .report-breakdown .panel-title-row p').textContent =
                'Payroll register totals in Indian rupees, calculated by the portal.';
            document.querySelector('#view-settings .subheading').textContent = `Signed in as ${source.userEmail || 'portal user'} · Payroll data is stored in SQLite.`;
            const companyPanel = byId('settings-companies').closest('.settings-panel');
            companyPanel.querySelector('.panel-title-row p').textContent = 'Companies represented in the imported employee records';
            const workflowPanel = document.querySelector('#view-settings .settings-rules').closest('.settings-panel');
            workflowPanel.querySelector('.panel-title-row h2').textContent = 'Payroll rules and workflow';
            workflowPanel.querySelector('.panel-title-row p').textContent = 'The payroll Read Me defines the rules; SQLite stores the operating data.';
            const ruleDescriptions = workflowPanel.querySelectorAll('.settings-rules dd');
            const hasJoiningAge = employees.some((employee) => Number.isInteger(employee.ageAtJoining));
            ruleDescriptions[1].textContent = hasJoiningAge
                ? 'Calculated server-side from date of birth when present; otherwise uses the employee master group'
                : 'Staff type follows the employee master; age at joining is not stored';
            ruleDescriptions[2].textContent = 'Selected employees only; gross, deductions and net are calculated locally';
            ruleDescriptions[3].textContent = 'Calculated in the portal from the configured statutory settings';
            ruleDescriptions[4].textContent = 'Employee records, payroll results and archive history are stored in SQLite';
            ruleDescriptions[5].textContent = source.periodLabel || source.payrollPeriod || 'Not set';
            ruleDescriptions[6].textContent = String(source.calendarDays || 'Not set');
            byId('add-employee-button').hidden = true;
            document.querySelector('#view-employees .classification-note').textContent =
                hasJoiningAge
                    ? 'Age at joining is calculated server-side where date of birth is present; otherwise staff type follows the employee master group.'
                    : 'Staff type follows the imported employee master group; age at joining is not stored.';
            document.querySelector('#view-employees .metric-card:nth-child(2) small').textContent = 'Classification from the employee master';
            document.querySelector('#view-employees .metric-card:nth-child(3) small').textContent = 'Classification from the employee master';
            document.querySelector('.app-footer > span:last-child').textContent = 'SQLite payroll data · Amounts in INR';
            const warningBar = byId('dashboard-review-notice');
            if (source.dataReview?.pendingCount && source.canManageEmployeeData) {
                byId('dashboard-review-link').hidden = false;
            } else {
                byId('dashboard-review-link').hidden = true;
            }
            warningBar.hidden = !source.warnings?.length;
            const reviewSummary = source.dataReview?.pendingCount
                ? `${source.dataReview.pendingCount} employee records need verified salary or leave data. `
                : '';
            const historyWarning = source.warnings?.find((message) => message.includes('Payroll history rows'));
            byId('dashboard-review-message').textContent =
                `${reviewSummary}${historyWarning || (source.warnings?.join(' ') ?? '')}`;
            const payrollSourcesIncomplete = employees.some((employee) =>
                employee.status === 'active' && (employee.salaryDataMissing || employee.leaveDataMissing));
            byId('payroll-source-warning').hidden = !payrollSourcesIncomplete;
            byId('payroll-source-review-link').hidden = !source.canManageEmployeeData;
            byId('payroll-source-warning-message').textContent = source.canManageEmployeeData
                ? 'Complete verified salary and leave data for active employees before including them in payroll.'
                : 'Ask a portal administrator to verify incomplete salary and leave data before preparing payroll.';
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
            const group = employees.filter((employee) => employee.companyId === company.id);
            return summary ? summary.grossSalary : group.some((employee) => employee.baseSalary == null)
                ? null
                : group.reduce((sum, employee) => sum + employee.baseSalary, 0);
        }).filter((value) => value != null);
        const maxPay = Math.max(...values, 1);
        companies.forEach((company) => {
            const companyEmployees = employees.filter((employee) => employee.companyId === company.id);
            const summary = source.companyTotals?.find((item) => item.companyId === company.id);
            const total = summary ? summary.grossSalary
                : companyEmployees.some((employee) => employee.baseSalary == null)
                    ? null
                    : companyEmployees.reduce((sum, employee) => sum + employee.baseSalary, 0);
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
                ? 'No archived payroll history was found in SQLite.'
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
            if (source.canManageEmployeeData) {
                const details = node('button', 'row-action', 'Personal data');
                details.type = 'button';
                details.setAttribute('aria-label', `View personal fixed data for ${employee.name}`);
                details.addEventListener('click', () => openEmployeeDetails(employee));
                const review = node('button', 'row-action', 'Review');
                review.type = 'button';
                review.setAttribute('aria-label', `Review payroll source data for ${employee.name}`);
                review.addEventListener('click', () => openSourceDataDialog(employee));
                action.classList.add('employee-row-actions');
                action.append(details, review);
            } else if (isConnected) {
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
        fixedDataEmployeeId = employee.id;
        byId('employee-detail-title').textContent = employee.name;
        byId('employee-detail-subtitle').textContent = `${employee.id} · ${companyName(employee.companyId)}`;
        byId('employee-detail-feedback').hidden = true;
        byId('employee-fixed-data-edit').hidden = !source.canManageEmployeeData;
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
        secrets.forEach((field) => {
            const item = node('div', 'protected-field');
            const value = node('strong', 'protected-value', field.maskedValue);
            const hasValue = field.maskedValue !== 'Not provided';
            const reveal = node('button', 'button button-light protected-reveal',
                !hasValue ? 'Not entered' : (source.canRevealSensitive ? 'Show value' : 'Admin access required'));
            reveal.type = 'button';
            reveal.disabled = !hasValue || !source.canRevealSensitive;
            reveal.setAttribute('aria-label', !hasValue
                ? `${field.label} has not been entered`
                : `${source.canRevealSensitive ? 'Show' : 'Admin access required for'} ${field.label}`);
            reveal.addEventListener('click', () => {
                if (reveal.dataset.revealed === 'true') {
                    value.textContent = field.maskedValue;
                    reveal.textContent = 'Show value';
                    reveal.dataset.revealed = 'false';
                    return;
                }
                reveal.disabled = true;
                reveal.textContent = 'Checking access…';
                apiRequest('/api/reveal', {
                    method: 'POST',
                    body: JSON.stringify({ employeeId: employee.id, fieldKey: field.key, columnNumber: field.columnNumber })
                }).then(({ value: fullValue }) => {
                        value.textContent = fullValue;
                        reveal.textContent = 'Hide value';
                        reveal.dataset.revealed = 'true';
                        reveal.disabled = false;
                    }).catch((error) => {
                        reveal.textContent = 'Show value';
                        reveal.disabled = false;
                        byId('employee-detail-feedback').textContent =
                            error.message || 'The protected value could not be revealed.';
                        byId('employee-detail-feedback').hidden = false;
                    });
            });
            item.append(node('span', '', field.label), value, reveal);
            protectedFields.append(item);
        });
        byId('employee-detail-dialog').showModal();
    }

    async function openEmployeeFixedDataDialog() {
        const employee = employeeFor(fixedDataEmployeeId);
        if (!employee || !source.canManageEmployeeData) return;
        const button = byId('employee-fixed-data-edit');
        button.disabled = true;
        try {
            const { values } = await apiRequest('/api/employee-fixed-data/read', {
                method: 'POST',
                body: JSON.stringify({ employeeId: employee.id })
            });
            const form = byId('employee-fixed-data-form');
            for (const [key, value] of Object.entries(values)) {
                form.elements.namedItem(key).value = value || '';
            }
            byId('employee-fixed-data-title').textContent = `${employee.name} · fixed details`;
            byId('employee-fixed-data-error').hidden = true;
            byId('employee-fixed-data-dialog').showModal();
        } catch (error) {
            byId('employee-detail-feedback').textContent =
                error.message || 'The employee details could not be loaded.';
            byId('employee-detail-feedback').hidden = false;
        } finally {
            button.disabled = false;
        }
    }

    function renderSourceDataReview() {
        const query = byId('data-review-search').value.trim().toLowerCase();
        const companyId = byId('data-review-company').value;
        const filter = byId('data-review-filter').value;
        const rows = employees.filter((employee) => {
            const pending = employee.salaryDataMissing || employee.leaveDataMissing;
            const matchesStatus = filter === 'all' || (filter === 'pending' ? pending : !pending);
            return matchesStatus
                && (companyId === 'all' || employee.companyId === companyId)
                && `${employee.name} ${employee.id}`.toLowerCase().includes(query);
        });
        const body = byId('data-review-table');
        body.replaceChildren();
        rows.forEach((employee) => {
            const row = node('tr');
            cell(row, '').append(personCell(employee));
            cell(row, companyName(employee.companyId), 'company-cell');
            cell(row, employee.salaryDataMissing ? 'Needs review' : 'Verified',
                employee.salaryDataMissing ? 'review-cell' : 'verified-cell');
            cell(row, employee.leaveDataMissing ? 'Needs review' : 'Verified',
                employee.leaveDataMissing ? 'review-cell' : 'verified-cell');
            const status = employee.salaryDataMissing || employee.leaveDataMissing
                ? tag('Needs review', 'review-needed')
                : tag('Complete', 'active');
            cell(row, '').append(status);
            const actionCell = cell(row, '');
            const edit = node('button', 'row-action', 'Review data');
            edit.type = 'button';
            edit.addEventListener('click', () => openSourceDataDialog(employee));
            actionCell.append(edit);
            body.append(row);
        });
        byId('data-review-pending').textContent = source.dataReview?.pendingCount ?? 0;
        byId('data-review-salary').textContent = source.dataReview?.salaryMissingCount ?? 0;
        byId('data-review-leave').textContent = source.dataReview?.leaveMissingCount ?? 0;
        byId('data-review-nav-count').textContent = source.dataReview?.pendingCount ?? 0;
        byId('data-review-empty').hidden = rows.length !== 0;
        byId('data-review-result-count').textContent = `Showing ${rows.length} of ${employees.length} employees`;
    }

    function openSourceDataDialog(employee) {
        byId('source-data-dialog').dataset.employeeId = employee.id;
        const values = [
            ['source-basic-salary', employee.salaryDataMissing ? '' : employee.baseSalary],
            ['source-fixed-allowance', employee.fixedAllowance],
            ['source-per-day-rate', employee.perDayRate],
            ['source-health-insurance', employee.healthInsurance],
            ['source-lic-deduction', employee.licDeduction],
            ['source-el-entitlement', employee.leaveDataMissing ? '' : employee.leaveBalance.elEntitlement],
            ['source-el-balance', employee.leaveDataMissing ? '' : employee.leaveBalance.elBalance],
            ['source-cl-entitlement', employee.leaveDataMissing ? '' : employee.leaveBalance.clEntitlement],
            ['source-cl-balance', employee.leaveDataMissing ? '' : employee.leaveBalance.clBalance]
        ];
        byId('source-data-form').reset();
        byId('source-data-error').hidden = true;
        byId('source-data-title').textContent = `Verify ${employee.name}`;
        byId('source-data-subtitle').textContent = `${employee.id} · ${companyName(employee.companyId)}. Save only values confirmed against an authoritative record.`;
        values.forEach(([id, value]) => {
            byId(id).value = value == null ? '' : String(value);
        });
        byId('source-data-dialog').showModal();
    }

    async function saveSourceData(event) {
        event.preventDefault();
        const fields = {
            basicSalary: 'source-basic-salary',
            fixedAllowance: 'source-fixed-allowance',
            perDayRate: 'source-per-day-rate',
            healthInsurance: 'source-health-insurance',
            licDeduction: 'source-lic-deduction',
            elEntitlement: 'source-el-entitlement',
            elBalance: 'source-el-balance',
            clEntitlement: 'source-cl-entitlement',
            clBalance: 'source-cl-balance'
        };
        const values = Object.fromEntries(Object.entries(fields).map(([key, id]) => [
            key,
            Number(byId(id).value)
        ]));
        const employeeId = byId('source-data-dialog').dataset.employeeId;
        const save = byId('source-data-save');
        save.disabled = true;
        byId('source-data-error').hidden = true;
        try {
            await apiRequest('/api/employee-payroll-data', {
                method: 'POST',
                body: JSON.stringify({
                    employeeId,
                    values,
                    confirmed: byId('source-data-confirmed').checked
                })
            });
            window.location.reload();
        } catch (error) {
            byId('source-data-error').textContent = error.message || 'Employee payroll data could not be saved.';
            byId('source-data-error').hidden = false;
            save.disabled = false;
        }
    }

    function updateRegisterOptions() {
        const select = byId('register-select');
        select.replaceChildren();
        registerNames.forEach((registerName) => select.append(new Option(registerName, registerName)));
        select.value = 'Salary Register';
    }

    function loadRegisterPage(registerName, startRow) {
        if (registerLoading) return;
        registerLoading = true;
        byId('register-title').textContent = registerName;
        byId('register-caption').textContent = 'Loading local payroll data…';
        byId('register-feedback').textContent = '';
        byId('register-body').replaceChildren();
        byId('register-head').replaceChildren();
        byId('register-page-status').textContent = 'Loading register rows…';
        byId('register-previous').disabled = true;
        byId('register-next').disabled = true;
        byId('export-register').disabled = true;
        apiRequest(`/api/register?registerName=${encodeURIComponent(registerName)}&startRow=${encodeURIComponent(startRow)}`)
            .then((page) => {
                currentRegisterPage = page;
                currentRegisterStart = startRow;
                renderRegisterPage(page);
                registerLoading = false;
            }).catch((error) => {
                registerLoading = false;
                byId('register-caption').textContent = 'Register could not be loaded.';
                byId('register-feedback').textContent =
                    error.message || `Unable to load the ${registerName} register.`;
                byId('register-page-status').textContent = '';
            });
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
        byId('register-title').textContent = page.registerName;
        byId('register-caption').textContent =
            'SQLite payroll values. Read-only view; sensitive columns are masked.';
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
        byId('process-payroll').disabled = selected.length === 0
            || selected.some((employee) => employee.salaryDataMissing || employee.leaveDataMissing);
        byId('process-payroll').title = selected.some((employee) => employee.salaryDataMissing || employee.leaveDataMissing)
            ? 'Complete verified salary and leave data for selected employees first.'
            : '';
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
            checkbox.disabled = employee.salaryDataMissing || employee.leaveDataMissing;
            checkbox.setAttribute('aria-label', `Select ${employee.name} for payroll`);
            if (checkbox.disabled) checkbox.title = 'Complete this employee’s verified salary and leave data before payroll.';
            checkbox.addEventListener('change', () => {
                if (checkbox.checked && !checkbox.disabled) selectedIds.add(employee.id);
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
        const selectableEmployees = filteredPayrollEmployees.filter((employee) =>
            !employee.salaryDataMissing && !employee.leaveDataMissing);
        const selectedVisible = selectableEmployees.filter((employee) => selectedIds.has(employee.id)).length;
        const allSelected = selectableEmployees.length > 0 && selectedVisible === selectableEmployees.length;
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
        apiRequest('/api/payroll-preview', {
            method: 'POST',
            body: JSON.stringify({ employeeIds: selected.map((employee) => employee.id), period })
        }).then(showConnectedPreview)
            .catch((error) => {
                button.textContent = 'Prepare payroll preview →';
                button.disabled = selectedIds.size === 0;
                const result = byId('payroll-result');
                result.textContent = error.message || 'The local payroll preview failed. Check the payroll data and try again.';
                result.hidden = false;
            });
        return;
    }

    function showConnectedPreview(rows) {
        const result = byId('payroll-result');
        const gross = rows.reduce((sum, employee) => sum + employee.grossSalary, 0);
        const deductions = rows.reduce((sum, employee) => sum + employee.totalDeductions, 0);
        const net = rows.reduce((sum, employee) => sum + employee.netPayable, 0);
        const heading = node('strong', '', `${rows.length} selected ${rows.length === 1 ? 'employee' : 'employees'} · local payroll preview`);
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
        renderAttendanceImport();
        const company = byId('attendance-company-filter').value;
        const subset = employees.filter((employee) => company === 'all' || employee.companyId === company);
        const body = byId('attendance-table');
        body.replaceChildren();
        subset.forEach((employee) => {
            const row = node('tr');
            cell(row, '').append(personCell(employee));
            cell(row, companyName(employee.companyId), 'company-cell');
            const attendance = employee.attendance || {
                workDays: 0,
                leaveDays: 0,
                longestContinuousSpell: 0,
                lopDays: 0,
                lopAmount: 0,
                processAllowance: 0,
                punctualIncentive: 0,
                fullAttendanceBonus: 0
            };
            const inputFields = [
                ['workDays', attendance.workDays, false],
                ['leaveDays', attendance.leaveDays, false],
                ['longestContinuousSpell', attendance.longestContinuousSpell, false]
            ];
            inputFields.forEach(([field, value]) => appendAttendanceInput(row, employee, field, value, false));
            cell(row, attendance.lopDays == null ? 'Review source' : attendance.lopDays, 'align-right');
            cell(row, attendance.lopAmount == null ? 'Review source' : money(attendance.lopAmount), 'align-right amount-cell');
            [
                ['processAllowance', attendance.processAllowance, true],
                ['punctualIncentive', attendance.punctualIncentive, true],
                ['fullAttendanceBonus', attendance.fullAttendanceBonus, true]
            ].forEach(([field, value, isMoney]) => appendAttendanceInput(row, employee, field, value, isMoney));
            const actionCell = cell(row, '');
            const action = node('div', 'attendance-action');
            const save = node('button', 'attendance-save', 'Save');
            save.type = 'button';
            save.disabled = source.canUpdateAttendance === false;
            if (save.disabled) save.hidden = true;
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
            ? employees.some((employee) => employee.leaveDataMissing)
                ? 'Review source'
                : employees.reduce((sum, employee) => sum + employee.leaveBalance.clTaken + employee.leaveBalance.elTaken, 0)
            : employees.reduce((sum, employee) => sum + employee.leaveUsed, 0);
        renderLeaveRequests();
    }

    function renderAttendanceImport() {
        const panel = byId('attendance-import-panel');
        const form = byId('attendance-import-form');
        const canImport = Boolean(source.canUpdateAttendance) && !source.periodArchived;
        panel.hidden = !source.canUpdateAttendance;
        form.querySelectorAll('input, button').forEach((control) => {
            control.disabled = !canImport;
        });
        byId('attendance-import-period').textContent = source.periodLabel || source.payrollPeriod;
        if (source.periodArchived) {
            byId('attendance-import-feedback').textContent = 'This payroll month is archived; attendance cannot be changed.';
        }
    }

    async function previewAttendanceImport(event) {
        event.preventDefault();
        const file = byId('attendance-import-file').files[0];
        const feedback = byId('attendance-import-feedback');
        if (!file) {
            feedback.textContent = 'Choose a CSV or .xlsx attendance file first.';
            return;
        }
        const previewButton = byId('attendance-import-preview');
        previewButton.disabled = true;
        previewButton.textContent = 'Checking roster…';
        feedback.textContent = 'Checking the file against every active employee…';
        byId('attendance-import-preview-panel').hidden = true;
        attendancePreviewRows = null;
        try {
            const preview = await apiRequest('/api/attendance/preview', {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Upload-Filename': file.name
                },
                body: file
            });
            attendancePreviewRows = preview.rows;
            const rows = byId('attendance-import-rows');
            rows.replaceChildren();
            preview.rows.forEach((attendance) => {
                const employee = employeeFor(attendance.employeeId);
                const row = node('div', 'attendance-import-row');
                row.append(
                    node('strong', '', employee?.name || attendance.employeeId),
                    node('span', '', attendance.employeeId),
                    node('span', '', `${attendance.workDays} work · ${attendance.leaveDays} leave`),
                    node('span', '', `Longest spell ${attendance.longestContinuousSpell}`)
                );
                rows.append(row);
            });
            byId('attendance-import-summary').textContent =
                `${preview.rows.length} active employees · ${preview.period} · ${preview.calendarDays} calendar days. No data has been changed yet.`;
            byId('attendance-import-preview-panel').hidden = false;
            feedback.textContent = 'Roster validated. Review the preview, then confirm the import.';
        } catch (error) {
            feedback.textContent = error.message || 'The attendance file could not be validated.';
        } finally {
            previewButton.disabled = !source.canUpdateAttendance || source.periodArchived;
            previewButton.textContent = 'Preview attendance';
        }
    }

    async function confirmAttendanceImport() {
        if (!attendancePreviewRows) return;
        const button = byId('attendance-import-confirm');
        const feedback = byId('attendance-import-feedback');
        button.disabled = true;
        button.textContent = 'Importing…';
        try {
            const result = await apiRequest('/api/attendance/import', {
                method: 'POST',
                body: JSON.stringify({ rows: attendancePreviewRows })
            });
            feedback.textContent = `${result.importedCount} employee attendance records saved for ${result.period}. Reloading payroll calculations…`;
            window.location.reload();
        } catch (error) {
            feedback.textContent = error.message || 'Attendance could not be imported.';
            button.disabled = false;
            button.textContent = 'Import and recalculate payroll';
        }
    }

    function cancelAttendanceImportPreview() {
        attendancePreviewRows = null;
        byId('attendance-import-preview-panel').hidden = true;
        byId('attendance-import-rows').replaceChildren();
        byId('attendance-import-feedback').textContent = '';
    }

    function downloadAttendanceTemplate() {
        exportCsv('attendance-import-template.csv', [
            'EMP ID',
            'WORK DAYS',
            'LEAVE DAYS THIS MONTH',
            'LONGEST CONTINUOUS SPELL',
            'PROCESS ALLOWANCE',
            'PUNCTUAL INCENTIVE',
            'FULL ATT. BONUS'
        ], []);
    }

    function renderAdvances() {
        const form = byId('advance-create-form');
        const canManage = Boolean(source.canManageAdvances);
        form.hidden = !canManage;
        const employeeSelect = byId('advance-employee');
        employeeSelect.replaceChildren(new Option('Choose an active employee', ''));
        employees.filter((employee) => employee.status === 'active')
            .forEach((employee) => employeeSelect.append(new Option(`${employee.name} (${employee.id})`, employee.id)));
        const createButton = byId('advance-create-button');
        createButton.disabled = !employeeSelect.options.length
            || employees.every((employee) => employee.status !== 'active');

        const body = byId('advance-table');
        body.replaceChildren();
        const advances = Array.isArray(source.advances) ? source.advances : [];
        if (!advances.length) {
            const row = node('tr');
            const empty = cell(row, 'No advances or loans recorded.', 'empty-state-cell');
            empty.colSpan = 9;
            body.append(row);
        }
        advances.forEach((advance) => {
            const row = node('tr');
            cell(row, '').append(node('strong', '', advance.employeeName), node('small', 'advance-employee-id', advance.employeeId));
            cell(row, advance.advanceType === 'school' ? 'School loan' : 'Advance');
            cell(row, money(advance.openingBalance), 'amount-cell');
            cell(row, money(advance.alreadyRecovered), 'amount-cell');
            cell(row, money(advance.currentBalance), 'amount-cell');
            if (canManage) {
                const monthlyCell = cell(row, '');
                const remarksCell = cell(row, '');
                const statusCell = cell(row, '');
                const actions = cell(row, '');
                const monthly = document.createElement('input');
                monthly.className = 'advance-edit-input';
                monthly.type = 'number';
                monthly.min = '0';
                monthly.max = '100000000';
                monthly.step = '0.01';
                monthly.value = String(advance.monthlyDeduction);
                monthly.setAttribute('aria-label', `Monthly deduction for ${advance.employeeName}`);
                monthlyCell.append(monthly);
                const remarks = document.createElement('input');
                remarks.className = 'advance-edit-input';
                remarks.type = 'text';
                remarks.maxLength = 500;
                remarks.value = advance.remarks;
                remarks.setAttribute('aria-label', `Remarks for ${advance.employeeName}`);
                remarksCell.append(remarks);
                const active = document.createElement('input');
                active.type = 'checkbox';
                active.checked = advance.isActive;
                active.disabled = !advance.isActive && advance.currentBalance <= 0;
                active.setAttribute('aria-label', `Active recovery for ${advance.employeeName}`);
                statusCell.append(active, node('span', '', advance.isActive ? ' Active' : ' Closed'));
                const save = node('button', 'button button-light advance-save', 'Save');
                save.type = 'button';
                save.addEventListener('click', async () => {
                    save.disabled = true;
                    byId('advance-feedback').textContent = `Saving ${advance.employeeName}'s advance…`;
                    try {
                        await apiRequest(`/api/advances/${advance.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                                values: {
                                    monthlyDeduction: Number(monthly.value),
                                    remarks: remarks.value,
                                    isActive: active.checked
                                }
                            })
                        });
                        window.location.reload();
                    } catch (error) {
                        byId('advance-feedback').textContent = error.message || 'The advance could not be updated.';
                        save.disabled = false;
                    }
                });
                actions.append(save);
            } else {
                cell(row, money(advance.monthlyDeduction), 'amount-cell');
                cell(row, advance.remarks);
                cell(row, advance.isActive ? 'Active' : 'Closed');
                cell(row, '');
            }
            body.append(row);
        });
    }

    async function createAdvance(event) {
        event.preventDefault();
        const button = byId('advance-create-button');
        const feedback = byId('advance-feedback');
        button.disabled = true;
        feedback.textContent = 'Adding shared advance…';
        try {
            await apiRequest('/api/advances', {
                method: 'POST',
                body: JSON.stringify({
                    values: {
                        employeeId: byId('advance-employee').value,
                        advanceType: byId('advance-type').value,
                        openingBalance: Number(byId('advance-original').value),
                        alreadyRecovered: Number(byId('advance-recovered').value),
                        monthlyDeduction: Number(byId('advance-monthly').value),
                        remarks: byId('advance-remarks').value
                    }
                })
            });
            feedback.textContent = 'Advance saved. Reloading the shared payroll data…';
            window.location.reload();
        } catch (error) {
            feedback.textContent = error.message || 'The advance could not be added.';
            button.disabled = false;
        }
    }

    function appendAttendanceInput(row, employee, field, value, isMoney) {
        const input = document.createElement('input');
        input.className = `attendance-input${isMoney ? ' money-input' : ''}`;
        input.type = 'number';
        input.min = '0';
        input.max = isMoney ? '10000000' : String(source.calendarDays || 31);
        input.step = isMoney ? '1' : '0.5';
        input.value = value == null ? '' : String(value);
        input.dataset.field = field;
        input.disabled = source.canUpdateAttendance === false;
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
            apiRequest('/api/attendance', {
                method: 'POST',
                body: JSON.stringify({ employeeId: employee.id, fields })
            }).then(() => {
                    button.textContent = 'Saved';
                    button.classList.add('saved');
                    window.setTimeout(() => window.location.reload(), 500);
                }).catch((error) => {
                    button.disabled = false;
                    button.textContent = 'Save';
                    const feedback = node('span', 'attendance-feedback', error.message || 'Attendance update failed. Try again.');
                    row.querySelector('.attendance-action').append(feedback);
                });
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
                info.append(node('strong', '', employee.name));
                info.append(node('small', '', employee.leaveDataMissing
                    ? `${employee.id} · Leave entitlements and opening balances need administrator verification`
                    : `${employee.id} · CL: ${balance.clTaken}/${balance.clEntitlement} used (${balance.clBalance} left) · EL: ${balance.elTaken}/${balance.elEntitlement} used (${balance.elBalance} left)`));
                row.append(avatar(employee), info, employee.leaveDataMissing
                    ? tag('Review source', 'review-needed')
                    : tag(staffLabel(employee), staffType(employee)));
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
                node('strong', 'summary-line-amount', total == null ? 'No payroll calculated' : money(total))
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
                node('span', 'settings-company-count', `${staff.length} employees in portal data`)
            );
            container.append(row);
        });
        byId('setting-pay-period').textContent = source.periodLabel || source.payrollPeriod || 'Not set';
        byId('setting-calendar-days').textContent = source.calendarDays || 'Not set';
        const rulesForm = byId('payroll-rules-form');
        rulesForm.hidden = !source.canManagePayrollRules;
        const rules = source.payrollRules || {};
        rulesForm.querySelectorAll('[data-rule]').forEach((input) => {
            const value = rules[input.dataset.rule];
            input.value = input.dataset.percent === 'true'
                ? String(Number(value) * 100)
                : String(value ?? '');
        });
    }

    async function savePayrollRules(event) {
        event.preventDefault();
        const form = byId('payroll-rules-form');
        const values = {};
        form.querySelectorAll('[data-rule]').forEach((input) => {
            const entered = Number(input.value);
            values[input.dataset.rule] = input.dataset.percent === 'true' ? entered / 100 : entered;
        });
        const feedback = byId('payroll-rules-feedback');
        feedback.textContent = 'Saving shared payroll rules…';
        const save = byId('save-payroll-rules');
        save.disabled = true;
        try {
            await apiRequest('/api/payroll-rules', {
                method: 'POST',
                body: JSON.stringify({ values })
            });
            feedback.textContent = 'Rules saved for all portal users. Payroll previews now use the updated values.';
            window.setTimeout(() => window.location.reload(), 800);
        } catch (error) {
            feedback.textContent = error.message || 'Shared payroll rules could not be saved.';
        } finally {
            save.disabled = false;
        }
    }

    function configurePayrollActions() {
        const archiveButton = byId('archive-payroll');
        archiveButton.hidden = !source.canUpdateAttendance || source.periodArchived;
        const sourceDataIncomplete = employees.some((employee) =>
            employee.status === 'active' && (employee.salaryDataMissing || employee.leaveDataMissing));
        archiveButton.disabled = Boolean(source.esiReviewRequiredCount) || sourceDataIncomplete;
        archiveButton.title = source.esiReviewRequiredCount
            ? 'Review ESI coverage statuses before archiving payroll.'
            : (sourceDataIncomplete ? 'Verify salary and leave source data for every active employee before archiving.' : '');

        const periodPanel = byId('payroll-period-panel');
        periodPanel.hidden = !source.canUpdateAttendance || !source.periodArchived;
        const [year, month] = source.payrollPeriod.split('-').map(Number);
        const nextDate = new Date(Date.UTC(year, month, 1));
        byId('next-payroll-period').value =
            `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}`;

        const esiPanel = byId('esi-review-panel');
        esiPanel.hidden = !source.canReviewEsi || !source.esiReviewRequiredCount;
        const esiEmployee = byId('esi-employee');
        esiEmployee.replaceChildren();
        (source.esiReviewRequiredEmployees || []).forEach((employee) => {
            esiEmployee.append(new Option(`${employee.name} (${employee.id})`, employee.id));
        });
        if (source.esiReviewRequiredEmployees?.length) {
            byId('esi-coverage-status').value = source.esiReviewRequiredEmployees[0].status || 'N';
        }
    }

    async function archiveCurrentPayroll() {
        const button = byId('archive-payroll');
        if (!window.confirm(`Archive payroll for ${source.periodLabel}? This records the payroll history and resets this month's leave inputs.`)) return;
        button.disabled = true;
        button.textContent = 'Archiving…';
        try {
            await apiRequest('/api/archive', { method: 'POST', body: JSON.stringify({}) });
            window.location.reload();
        } catch (error) {
            button.disabled = false;
            button.textContent = 'Archive payroll & close month';
            byId('archive-feedback').textContent = error.message || 'Payroll could not be archived.';
        }
    }

    async function startNextPayrollPeriod(event) {
        event.preventDefault();
        const button = byId('start-payroll-period');
        button.disabled = true;
        byId('payroll-period-feedback').textContent = '';
        try {
            await apiRequest('/api/payroll-period', {
                method: 'POST',
                body: JSON.stringify({ period: byId('next-payroll-period').value })
            });
            window.location.reload();
        } catch (error) {
            button.disabled = false;
            byId('payroll-period-feedback').textContent = error.message || 'The next payroll period could not be started.';
        }
    }

    async function saveEsiCoverage(event) {
        event.preventDefault();
        const button = byId('save-esi-coverage');
        button.disabled = true;
        byId('esi-review-feedback').textContent = '';
        try {
            await apiRequest('/api/esi-coverage', {
                method: 'POST',
                body: JSON.stringify({
                    employeeId: byId('esi-employee').value,
                    status: byId('esi-coverage-status').value
                })
            });
            window.location.reload();
        } catch (error) {
            button.disabled = false;
            byId('esi-review-feedback').textContent = error.message || 'ESI coverage could not be updated.';
        }
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
        renderSourceDataReview();
        renderPayrollSelection();
        renderAttendance();
        renderReports();
        renderSettings();
        renderAdvances();
    }

    async function signOutOfPortal() {
        appShell.hidden = true;
        loginGate.hidden = false;
        loginButton.disabled = true;
        loginButton.textContent = 'Signing out…';
        try {
            await apiRequest('/api/logout', { method: 'POST' });
            csrfToken = null;
            window.location.reload();
        } catch (error) {
            showLoginError(error);
        }
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
    byId('data-review-search').addEventListener('input', renderSourceDataReview);
    byId('data-review-company').addEventListener('change', renderSourceDataReview);
    byId('data-review-filter').addEventListener('change', renderSourceDataReview);
    byId('source-data-form').addEventListener('submit', saveSourceData);
    byId('source-data-close').addEventListener('click', () => byId('source-data-dialog').close());
    byId('source-data-cancel').addEventListener('click', () => byId('source-data-dialog').close());
    byId('source-data-dialog').addEventListener('click', (event) => {
        if (event.target === byId('source-data-dialog')) byId('source-data-dialog').close();
    });
    document.querySelectorAll('#payroll-company-filter, #payroll-type-filter')
        .forEach((select) => select.addEventListener('change', renderPayrollSelection));
    byId('select-all-visible').addEventListener('change', () => {
        filteredPayrollEmployees.forEach((employee) => {
            if (byId('select-all-visible').checked
                && !employee.salaryDataMissing && !employee.leaveDataMissing) selectedIds.add(employee.id);
            else selectedIds.delete(employee.id);
        });
        byId('payroll-result').hidden = true;
        renderPayrollSelection();
    });
    byId('select-toggle').addEventListener('click', () => {
        const selectableEmployees = filteredPayrollEmployees.filter((employee) =>
            !employee.salaryDataMissing && !employee.leaveDataMissing);
        const select = selectableEmployees.some((employee) => !selectedIds.has(employee.id));
        selectableEmployees.forEach((employee) => {
            if (select) selectedIds.add(employee.id);
            else selectedIds.delete(employee.id);
        });
        byId('payroll-result').hidden = true;
        renderPayrollSelection();
    });
    byId('process-payroll').addEventListener('click', processPayroll);
    byId('payroll-source-review-link').addEventListener('click', () => showView('data-review'));
    byId('dashboard-review-link').addEventListener('click', () => showView('data-review'));
    byId('attendance-company-filter').addEventListener('change', renderAttendance);
    byId('attendance-import-form').addEventListener('submit', previewAttendanceImport);
    byId('attendance-import-template').addEventListener('click', downloadAttendanceTemplate);
    byId('attendance-import-confirm').addEventListener('click', confirmAttendanceImport);
    byId('attendance-import-cancel').addEventListener('click', cancelAttendanceImportPreview);
    byId('archive-payroll').addEventListener('click', archiveCurrentPayroll);
    byId('payroll-period-form').addEventListener('submit', startNextPayrollPeriod);
    byId('payroll-rules-form').addEventListener('submit', savePayrollRules);
    byId('advance-create-form').addEventListener('submit', createAdvance);
    byId('esi-coverage-form').addEventListener('submit', saveEsiCoverage);
    byId('add-employee-button').addEventListener('click', () => openEmployeeDialog());
    byId('employee-form').addEventListener('submit', saveEmployee);
    document.querySelector('.dialog-close').addEventListener('click', () => byId('employee-dialog').close());
    document.querySelector('.dialog-cancel').addEventListener('click', () => byId('employee-dialog').close());
    byId('employee-dialog').addEventListener('click', (event) => {
        if (event.target === byId('employee-dialog')) byId('employee-dialog').close();
    });
    byId('employee-fixed-data-edit').addEventListener('click', openEmployeeFixedDataDialog);
    byId('employee-fixed-data-close').addEventListener('click', () => byId('employee-fixed-data-dialog').close());
    byId('employee-fixed-data-dialog').addEventListener('click', (event) => {
        if (event.target === byId('employee-fixed-data-dialog')) byId('employee-fixed-data-dialog').close();
    });
    byId('employee-fixed-data-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = byId('employee-fixed-data-form');
        const values = Object.fromEntries(
            ['dateOfBirth', 'mobile', 'aadhaar', 'pan', 'uan', 'bankAccount', 'bankName']
                .map((key) => [key, form.elements.namedItem(key).value.trim()])
        );
        const error = byId('employee-fixed-data-error');
        error.hidden = true;
        const save = form.querySelector('button[type="submit"]');
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
            await apiRequest('/api/employee-fixed-data', {
                method: 'POST',
                body: JSON.stringify({
                    employeeId: fixedDataEmployeeId,
                    values,
                    confirmed: form.elements.namedItem('confirmed').checked
                })
            });
            byId('employee-fixed-data-dialog').close();
            byId('employee-detail-dialog').close();
            window.location.reload();
        } catch (requestError) {
            error.textContent = requestError.message || 'The employee details could not be saved.';
            error.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = 'Save fixed details';
        }
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
        if (currentRegisterPage?.hasMore) loadRegisterPage(currentRegisterPage.registerName, currentRegisterPage.nextStartRow);
    });
    byId('register-previous').addEventListener('click', () => {
        loadRegisterPage(currentRegisterPage?.registerName || byId('register-select').value, Math.max(5, currentRegisterStart - 100));
    });
    byId('export-register').addEventListener('click', () => {
        if (!currentRegisterPage?.rows.length) return;
        exportCsv(`employees-pay-roll-${currentRegisterPage.registerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-page.csv`,
            ['Record number', ...currentRegisterPage.columns],
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
    configurePayrollActions();
    }

    appShell.hidden = true;
    loginGate.hidden = false;
    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        loginButton.disabled = true;
        loginButton.textContent = 'Signing in…';
        loginError.hidden = true;
        try {
            const result = await apiRequest('/api/login', {
                method: 'POST',
                body: JSON.stringify({
                    email: document.getElementById('login-email').value,
                    password: document.getElementById('login-password').value
                })
            });
            csrfToken = result.csrfToken;
            loginButton.textContent = 'Loading payroll data…';
            const source = await apiRequest('/api/portal-data');
            initialize(source);
            document.getElementById('login-password').value = '';
        } catch (error) {
            document.getElementById('login-password').value = '';
            showLoginError(error);
        }
    });

    async function restoreSession() {
        try {
            const response = await fetch('/api/session', { credentials: 'same-origin' });
            if (response.status === 401) return;
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Your portal session could not be restored.');
            csrfToken = result.csrfToken;
            const source = await apiRequest('/api/portal-data');
            initialize(source);
        } catch (error) {
            showLoginError(error);
        }
    }

    restoreSession();
})();
