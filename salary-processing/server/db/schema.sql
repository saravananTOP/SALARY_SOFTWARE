CREATE TABLE IF NOT EXISTS portal_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'payroll', 'read-only')),
    disabled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS portal_password_recovery_keys (
    user_id INTEGER PRIMARY KEY REFERENCES portal_users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id BIGINT REFERENCES portal_users(id),
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portal_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS portal_audit_log_created_at_idx
    ON portal_audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS portal_sessions (
    sid TEXT NOT NULL PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS portal_sessions_expire_idx
    ON portal_sessions (expire);

CREATE TABLE IF NOT EXISTS payroll_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_employees (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES payroll_companies(id),
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    staff_type TEXT NOT NULL CHECK (staff_type IN ('active', 'retainer')),
    joining_date TEXT,
    date_of_birth TEXT,
    basic_salary REAL NOT NULL CHECK (basic_salary >= 0),
    salary_data_missing INTEGER NOT NULL DEFAULT 0 CHECK (salary_data_missing IN (0, 1)),
    fixed_allowance REAL NOT NULL DEFAULT 0 CHECK (fixed_allowance >= 0),
    per_day_rate REAL NOT NULL DEFAULT 0 CHECK (per_day_rate >= 0),
    pf_applicable INTEGER NOT NULL DEFAULT 0 CHECK (pf_applicable IN (0, 1)),
    esi_exempt INTEGER NOT NULL DEFAULT 0 CHECK (esi_exempt IN (0, 1)),
    health_insurance REAL NOT NULL DEFAULT 0 CHECK (health_insurance >= 0),
    lic_deduction REAL NOT NULL DEFAULT 0 CHECK (lic_deduction >= 0),
    el_entitlement REAL NOT NULL DEFAULT 0 CHECK (el_entitlement >= 0),
    cl_entitlement REAL NOT NULL DEFAULT 0 CHECK (cl_entitlement >= 0),
    el_balance REAL NOT NULL DEFAULT 0 CHECK (el_balance >= 0),
    cl_balance REAL NOT NULL DEFAULT 0 CHECK (cl_balance >= 0),
    el_taken REAL NOT NULL DEFAULT 0 CHECK (el_taken >= 0),
    cl_taken REAL NOT NULL DEFAULT 0 CHECK (cl_taken >= 0),
    leave_data_missing INTEGER NOT NULL DEFAULT 0 CHECK (leave_data_missing IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    effective_date TEXT,
    pan TEXT,
    mobile TEXT,
    aadhaar TEXT,
    uan TEXT,
    bank_account TEXT,
    bank_name TEXT,
    esi_coverage_status TEXT NOT NULL DEFAULT 'N' CHECK (esi_coverage_status IN ('Y', 'N')),
    esi_coverage_period TEXT,
    esi_status_reviewed TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payroll_employees_company_idx
    ON payroll_employees (company_id, status, name);

CREATE TABLE IF NOT EXISTS payroll_attendance (
    period TEXT NOT NULL,
    employee_id TEXT NOT NULL REFERENCES payroll_employees(id),
    work_days REAL NOT NULL DEFAULT 0 CHECK (work_days >= 0),
    leave_days REAL NOT NULL DEFAULT 0 CHECK (leave_days >= 0),
    longest_continuous_spell REAL NOT NULL DEFAULT 0 CHECK (longest_continuous_spell >= 0),
    process_allowance REAL NOT NULL DEFAULT 0 CHECK (process_allowance >= 0),
    punctual_incentive REAL NOT NULL DEFAULT 0 CHECK (punctual_incentive >= 0),
    full_attendance_bonus REAL NOT NULL DEFAULT 0 CHECK (full_attendance_bonus >= 0),
    updated_by INTEGER REFERENCES portal_users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (period, employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_advances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL REFERENCES payroll_employees(id),
    advance_type TEXT NOT NULL CHECK (advance_type IN ('regular', 'school')),
    opening_balance REAL NOT NULL CHECK (opening_balance >= 0),
    recovered_before_migration REAL NOT NULL DEFAULT 0 CHECK (recovered_before_migration >= 0),
    current_balance REAL NOT NULL CHECK (current_balance >= 0),
    monthly_deduction REAL NOT NULL DEFAULT 0 CHECK (monthly_deduction >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payroll_advances_employee_idx
    ON payroll_advances (employee_id, advance_type);

CREATE TABLE IF NOT EXISTS payroll_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_tax_slabs (
    lower_bound REAL NOT NULL CHECK (lower_bound >= 0),
    upper_bound REAL,
    rate REAL NOT NULL CHECK (rate >= 0 AND rate <= 1),
    PRIMARY KEY (lower_bound)
);

CREATE TABLE IF NOT EXISTS payroll_import_issues (
    code TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    record_count INTEGER NOT NULL CHECK (record_count >= 0)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
    period TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('archived')),
    archived_by INTEGER REFERENCES portal_users(id),
    archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    company_id TEXT NOT NULL,
    basic_total REAL NOT NULL,
    hra REAL NOT NULL DEFAULT 0,
    fixed_allowance REAL NOT NULL DEFAULT 0,
    ltw_allowance REAL NOT NULL DEFAULT 0,
    punctual_total REAL NOT NULL DEFAULT 0,
    process_allowance REAL NOT NULL DEFAULT 0,
    gross_salary REAL NOT NULL,
    employee_pf REAL NOT NULL DEFAULT 0,
    employee_esi REAL NOT NULL DEFAULT 0,
    health_insurance REAL NOT NULL DEFAULT 0,
    regular_advance REAL NOT NULL DEFAULT 0,
    school_advance REAL NOT NULL DEFAULT 0,
    lic_deduction REAL NOT NULL DEFAULT 0,
    total_deductions REAL NOT NULL,
    net_payable REAL NOT NULL,
    cl_used REAL NOT NULL DEFAULT 0,
    el_used REAL NOT NULL DEFAULT 0,
    lop_days REAL NOT NULL DEFAULT 0,
    lop_amount REAL NOT NULL DEFAULT 0,
    UNIQUE (period, employee_id)
);

CREATE INDEX IF NOT EXISTS payroll_history_period_idx
    ON payroll_history (period, company_id);
