function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Employees Pay Roll')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getPortalData() {
  var context = getAuthorizedSpreadsheet_();
  var spreadsheet = context.spreadsheet;
  var warnings = [];
  var companies = [
    { id: 'flavors-india', name: 'THE FLAVORS INDIA PVT LTD', shortName: 'The Flavors India' },
    { id: 'supreme-aromatics', name: 'THE SUPREME AROMATICS PVT LTD', shortName: 'The Supreme Aromatics' }
  ];
  var employeeGroups = [
    { sheetName: 'Employee Master - FA', companyId: 'flavors-india', defaultType: 'active' },
    { sheetName: 'Employee Master - FR', companyId: 'flavors-india', defaultType: 'retainer' },
    { sheetName: 'Employee Master - SA', companyId: 'supreme-aromatics', defaultType: 'retainer' }
  ];
  var employees = [];
  var employeeById = Object.create(null);

  employeeGroups.forEach(function (group, groupIndex) {
    var sheet = requireSheet_(spreadsheet, group.sheetName);
    requireHeaders_(sheet, 4, { 1: 'EMP ID', 2: 'NAME', 4: 'DATE OF JOINING', 9: 'BASIC', 22: 'STATUS' });
    var rowCount = Math.max(sheet.getLastRow() - 4, 0);
    if (!rowCount) return;

    var masterHeaders = sheet.getRange(4, 1, 1, 22).getDisplayValues()[0];
    var masterRows = sheet.getRange(5, 1, rowCount, 22).getValues();
    var masterDisplayRows = sheet.getRange(5, 1, rowCount, 22).getDisplayValues();
    var birthDateColumn = findBirthDateColumn_(masterHeaders);
    masterRows.forEach(function (masterRow, index) {
      var identity = masterRow.slice(0, 5);
      var id = String(identity[0] || '').trim();
      if (!id) return;
      if (employeeById[id]) throw new Error('Duplicate employee IDs were found in the employee masters. Correct the source sheets before opening payroll.');

      var payroll = masterRow.slice(8, 22);
      var statusText = String(payroll[13] || 'Active').trim();
      var staffTypeText = String(identity[4] || '').toLowerCase();
      var resolvedStaffType = staffTypeText.indexOf('retainer') >= 0
        ? 'retainer'
        : (staffTypeText.indexOf('active') >= 0 ? 'active' : group.defaultType);
      var joiningDate = identity[3];
      var birthDate = birthDateColumn < 0 ? null : masterRow[birthDateColumn];
      var ageAtJoining = ageAtJoining_(birthDate, joiningDate);
      if (ageAtJoining !== null) resolvedStaffType = ageAtJoining >= 58 ? 'retainer' : 'active';
      var employee = {
        id: id,
        name: String(identity[1] || '').trim(),
        title: String(identity[2] || '').trim(),
        joiningDate: formatDate_(joiningDate, spreadsheet),
        companyId: group.companyId,
        staffType: resolvedStaffType,
        ageAtJoining: ageAtJoining,
        baseSalary: amountOrNull_(payroll[0], group.sheetName, index + 5, warnings),
        fixedAllowance: amountOrNull_(payroll[1], group.sheetName, index + 5, warnings),
        perDayRate: amountOrNull_(payroll[2], group.sheetName, index + 5, warnings),
        pfApplicable: String(payroll[3] || '').toUpperCase() === 'Y',
        esiExempt: String(payroll[4] || '').toUpperCase() === 'Y',
        healthInsurance: amountOrNull_(payroll[5], group.sheetName, index + 5, warnings),
        licDeduction: amountOrNull_(payroll[6], group.sheetName, index + 5, warnings),
        elEntitlement: amountOrNull_(payroll[7], group.sheetName, index + 5, warnings),
        clEntitlement: amountOrNull_(payroll[8], group.sheetName, index + 5, warnings),
        elBalance: amountOrNull_(payroll[9], group.sheetName, index + 5, warnings),
        clBalance: amountOrNull_(payroll[10], group.sheetName, index + 5, warnings),
        elTaken: amountOrNull_(payroll[11], group.sheetName, index + 5, warnings),
        clTaken: amountOrNull_(payroll[12], group.sheetName, index + 5, warnings),
        status: normalizeStatus_(statusText),
        protectedFields: getMaskedSensitiveFields_(masterHeaders, masterDisplayRows[index]),
        initials: initials_(String(identity[1] || id)),
        color: ['#eeeafd', '#e4f3ed', '#fff0e2', '#e8effc', '#f9e9ee', '#f0eafa', '#e5f3f4', '#fff2df'][(employees.length + groupIndex) % 8]
      };
      employees.push(employee);
      employeeById[id] = employee;
    });
  });

  var attendanceById = readAttendance_(spreadsheet, employeeById, warnings);
  var leaveBalances = readLeaveBalances_(spreadsheet, employeeById, warnings);
  var salaryRows = readSalaryRegister_(spreadsheet, employeeById, warnings);
  var companyTotals = summarizeCompanies_(companies, employees, salaryRows);
  var payrollRuns = readPayrollHistory_(spreadsheet, companies, warnings);
  var settings = requireSheet_(spreadsheet, 'Settings');
  var payrollPeriod = parsePayrollPeriod_(settings.getRange('B4').getValue(), settings.getRange('B4').getDisplayValue());
  var calendarDays = integerOrNull_(settings.getRange('B5').getValue(), 'Settings!B5', warnings);
  if (!Number.isInteger(calendarDays) || calendarDays < 1 || calendarDays > 31) {
    throw new Error('Settings!B5 must contain a whole number from 1 to 31.');
  }
  var expectedCalendarDays = calendarDaysInPeriod_(payrollPeriod.value);
  if (calendarDays !== expectedCalendarDays) {
    warnings.push('Settings!B5 is ' + calendarDays + ', but ' + payrollPeriod.label + ' has ' + expectedCalendarDays + ' calendar days. Correct this setting before previewing payroll or editing attendance.');
  }
  var reportRows = readCompanyReports_(spreadsheet, warnings);
  var advanceRows = readAdvances_(spreadsheet, employeeById, warnings);
  employees.forEach(function (employee) {
    employee.attendance = attendanceById[employee.id] || emptyAttendance_();
    employee.leaveBalance = leaveBalances[employee.id] || emptyLeaveBalance_();
  });

  return {
    mode: 'google-sheets',
    userEmail: context.email,
    canRevealSensitive: isPortalAdmin_(context.email),
    sourceSpreadsheetUrl: spreadsheet.getUrl(),
    companies: companies,
    employees: employees,
    payrollRuns: payrollRuns,
    leaveRequests: [],
    leaveBalances: leaveBalances,
    advances: advanceRows,
    companyTotals: companyTotals,
    companyReports: reportRows,
    payrollPeriod: payrollPeriod.value,
    periodLabel: payrollPeriod.label,
    calendarDays: calendarDays,
    warnings: warnings
  };
}

function getPayrollRegisterPage(sheetName, startRow) {
  var context = getAuthorizedSpreadsheet_();
  var allowedSheets = [
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
  if (allowedSheets.indexOf(sheetName) < 0) throw new Error('Choose a supported payroll register.');
  var firstRow = Number(startRow);
  if (!Number.isInteger(firstRow) || firstRow < 5) throw new Error('The requested register page is invalid.');

  var sheet = requireSheet_(context.spreadsheet, sheetName);
  if (firstRow > sheet.getMaxRows()) throw new Error('The requested register page is outside the source sheet.');
  var lastColumn = sheet.getLastColumn();
  if (!lastColumn) return { sheetName: sheetName, columns: [], rows: [], startRow: firstRow, hasMore: false };
  if (lastColumn > 60) throw new Error('This register is wider than the portal supports. Review its columns in Google Sheets.');
  var headerRow = 4;
  var headers = sheet.getRange(headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  if (!headers.some(function (header) { return String(header || '').trim(); })) {
    throw new Error('The ' + sheetName + ' register does not have readable headers in row 4.');
  }

  var lastRow = sheet.getLastRow();
  var pageSize = 100;
  var endRow = Math.min(firstRow + pageSize - 1, lastRow);
  var rows = [];
  if (firstRow <= lastRow) {
    var values = sheet.getRange(firstRow, 1, endRow - firstRow + 1, lastColumn).getDisplayValues();
    rows = values.map(function (row, index) {
      return {
        rowNumber: firstRow + index,
        values: row.map(function (value, columnIndex) {
          return isSensitiveHeader_(headers[columnIndex]) ? maskSensitiveValue_(value, headers[columnIndex]) : value;
        })
      };
    }).filter(function (row) {
      return row.values.some(function (value) { return String(value || '').trim(); });
    });
  }
  return {
    sheetName: sheetName,
    columns: headers.map(function (header) { return String(header || '').trim(); }),
    rows: rows,
    startRow: firstRow,
    nextStartRow: endRow + 1,
    totalRows: Math.max(lastRow - headerRow, 0),
    hasMore: endRow < lastRow
  };
}

function revealEmployeeSensitiveField(employeeId, columnNumber) {
  var context = getAuthorizedSpreadsheet_();
  if (!isPortalAdmin_(context.email)) throw new Error('Full sensitive-data access is restricted to configured portal administrators.');
  var id = String(employeeId || '').trim();
  var column = Number(columnNumber);
  if (!id || id.length > 40 || !Number.isInteger(column) || column < 1 || column > 60) {
    throw new Error('The protected field request is invalid.');
  }
  var record = findEmployeeMasterRecord_(context.spreadsheet, id);
  if (!record) throw new Error('The employee was not found in the current employee masters.');
  var header = record.sheet.getRange(4, column).getDisplayValue();
  if (!isSensitiveHeader_(header)) throw new Error('That employee field is not eligible for protected-value reveal.');
  var value = record.sheet.getRange(record.rowNumber, column).getDisplayValue();
  if (!value) throw new Error('No value is present for this protected field.');
  Logger.log(JSON.stringify({
    event: 'sensitive-field-revealed',
    user: context.email,
    employeeId: id,
    field: String(header),
    timestamp: new Date().toISOString()
  }));
  return value;
}

function getSelectedPayrollPreview(employeeIds, requestedPeriod) {
  var context = getAuthorizedSpreadsheet_();
  if (!Array.isArray(employeeIds) || employeeIds.length < 1 || employeeIds.length > 100) {
    throw new Error('Select between 1 and 100 employees for a payroll preview.');
  }
  var normalizedIds = employeeIds.map(function (id) { return String(id || '').trim(); });
  if (normalizedIds.some(function (id) { return !id || id.length > 40; })) {
    throw new Error('The selected employee list contains an invalid ID.');
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new Error('The selected employee list contains duplicates. Refresh the page and try again.');
  }

  var settings = requireSheet_(context.spreadsheet, 'Settings');
  var activePeriod = parsePayrollPeriod_(settings.getRange('B4').getValue(), settings.getRange('B4').getDisplayValue());
  if (requestedPeriod !== activePeriod.value) {
    throw new Error('The payroll period in the portal does not match Settings!B4. Update the source sheet and reload before previewing.');
  }
  requireMatchingCalendarDays_(settings, activePeriod);

  var allowedEmployees = Object.create(null);
  [
    ['Employee Master - FA', 'flavors-india', 'active'],
    ['Employee Master - FR', 'flavors-india', 'retainer'],
    ['Employee Master - SA', 'supreme-aromatics', 'retainer']
  ].forEach(function (group) {
    var sheet = requireSheet_(context.spreadsheet, group[0]);
    var rowCount = Math.max(sheet.getLastRow() - 4, 0);
    if (!rowCount) return;
    var headers = sheet.getRange(4, 1, 1, 22).getDisplayValues()[0];
    var birthDateColumn = findBirthDateColumn_(headers);
    sheet.getRange(5, 1, rowCount, 22).getValues().forEach(function (row) {
      var id = String(row[0] || '').trim();
      if (!id) return;
      if (allowedEmployees[id]) throw new Error('Duplicate employee IDs were found in the employee masters. Correct the source sheets before preparing a preview.');
      var staffTypeText = String(row[4] || '').toLowerCase();
      var age = birthDateColumn < 0 ? null : ageAtJoining_(row[birthDateColumn], row[3]);
      var resolvedStaffType = staffTypeText.indexOf('retainer') >= 0
        ? 'retainer'
        : (staffTypeText.indexOf('active') >= 0 ? 'active' : group[2]);
      if (age !== null) resolvedStaffType = age >= 58 ? 'retainer' : 'active';
      allowedEmployees[id] = {
        companyId: group[1],
        staffType: resolvedStaffType,
        status: normalizeStatus_(row[21])
      };
    });
  });

  var register = requireSheet_(context.spreadsheet, 'Salary Register');
  requireHeaders_(register, 4, { 1: 'EMP ID', 2: 'NAME', 5: 'GROSS SALARY', 9: 'NET AMT' });
  var registerCount = Math.max(register.getLastRow() - 4, 0);
  var registerValues = registerCount ? register.getRange(5, 1, registerCount, 10).getValues() : [];
  var registerById = Object.create(null);
  registerValues.forEach(function (row, index) {
    var id = String(row[0] || '').trim();
    if (!id) return;
    if (registerById[id]) throw new Error('The Salary Register contains duplicate employee IDs. Correct it before preparing a preview.');
    registerById[id] = { values: row, rowNumber: index + 5 };
  });

  return normalizedIds.map(function (id) {
    if (!allowedEmployees[id]) throw new Error('A selected employee is not present in the current employee masters. Refresh and select again.');
    if (allowedEmployees[id].status === 'inactive') throw new Error('An inactive employee cannot be included in a payroll preview.');
    var entry = registerById[id];
    if (!entry) throw new Error('A selected employee has no calculated Salary Register row. Check the source formulas before previewing.');
    var row = entry.values;
    var numbers = row.slice(3, 10).map(function (value, index) {
      return requiredAmount_(value, 'Salary Register', entry.rowNumber, index + 4);
    });
    return {
      employeeId: id,
      name: String(row[1] || ''),
      companyId: allowedEmployees[id].companyId,
      staffType: allowedEmployees[id].staffType,
      basicTotal: numbers[0],
      grossSalary: numbers[1],
      employeePf: numbers[2],
      employeeEsi: numbers[3],
      totalDeductions: numbers[4],
      netPayable: numbers[5],
      referenceGross: numbers[6]
    };
  });
}

function updateAttendance(employeeId, input) {
  var context = getAuthorizedSpreadsheet_();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Attendance values are missing or invalid.');
  }
  var id = String(employeeId || '').trim();
  if (!id || id.length > 40) throw new Error('A valid employee ID is required.');
  var values = {
    workDays: input.workDays,
    leaveDays: input.leaveDays,
    longestContinuousSpell: input.longestContinuousSpell,
    processAllowance: input.processAllowance,
    punctualIncentive: input.punctualIncentive,
    fullAttendanceBonus: input.fullAttendanceBonus,
    totalLateDays: input.totalLateDays
  };
  var settings = requireSheet_(context.spreadsheet, 'Settings');
  var activePeriod = parsePayrollPeriod_(settings.getRange('B4').getValue(), settings.getRange('B4').getDisplayValue());
  var calendarDays = requireMatchingCalendarDays_(settings, activePeriod);
  var normalized = {};
  Object.keys(values).forEach(function (key) {
    var max = key === 'processAllowance' || key === 'punctualIncentive' || key === 'fullAttendanceBonus'
      ? 10000000
      : calendarDays;
    normalized[key] = validateNonnegativeInteger_(values[key], key, max);
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = requireSheet_(context.spreadsheet, 'Attendance');
    requireHeaders_(sheet, 4, { 1: 'EMP ID', 4: 'WORK DAYS', 6: 'LEAVE DAYS THIS MONTH', 7: 'LONGEST CONTINUOUS SPELL', 12: 'PROCESS ALLOWANCE', 14: 'PUNCTUAL INCENTIVE', 15: 'FULL ATT. BONUS', 18: 'TOTAL LATE DAYS' });
    var rowCount = Math.max(sheet.getLastRow() - 4, 0);
    if (!rowCount) throw new Error('The Attendance sheet has no employee rows.');
    var ids = sheet.getRange(5, 1, rowCount, 1).getDisplayValues();
    var matchingRows = [];
    ids.forEach(function (row, index) {
      if (String(row[0] || '').trim() === id) matchingRows.push(index + 5);
    });
    if (matchingRows.length !== 1) {
      throw new Error(matchingRows.length ? 'The employee appears more than once in Attendance.' : 'The employee was not found in the Attendance sheet.');
    }

    var rowNumber = matchingRows[0];
    [
      [4, normalized.workDays],
      [6, normalized.leaveDays],
      [7, normalized.longestContinuousSpell],
      [12, normalized.processAllowance],
      [14, normalized.punctualIncentive],
      [15, normalized.fullAttendanceBonus],
      [18, normalized.totalLateDays]
    ].forEach(function (item) {
      sheet.getRange(rowNumber, item[0]).setValue(item[1]);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return getPortalData();
}

function getAuthorizedSpreadsheet_() {
  var user = Session.getActiveUser().getEmail();
  if (!user) throw new Error('Google could not verify the signed-in account. Deploy the web app to require a Google account and execute as the accessing user.');
  var email = user.toLowerCase().trim();
  var configuredAllowlist = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS');
  if (configuredAllowlist) {
    var allowed = configuredAllowlist.split(/[;,\s]+/).map(function (value) { return value.toLowerCase().trim(); }).filter(Boolean);
    if (allowed.indexOf(email) < 0) throw new Error('This Google account is not on the portal access allowlist.');
  }

  var effectiveUser = Session.getEffectiveUser().getEmail();
  if (!effectiveUser || effectiveUser.toLowerCase().trim() !== email) {
    throw new Error('The web app must execute as the signed-in Google account, not as the deployer.');
  }
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error('The Apps Script SPREADSHEET_ID property is missing or invalid. Ask the administrator to configure it.');
  }
  return { email: email, spreadsheet: SpreadsheetApp.openById(spreadsheetId) };
}

function requireSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Required source tab "' + name + '" was not found. Confirm this is the payroll workbook and its tab names are unchanged.');
  return sheet;
}

function isPortalAdmin_(email) {
  var configuredAdmins = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  var admins = configuredAdmins.split(/[;,\s]+/)
    .map(function (value) { return value.toLowerCase().trim(); })
    .filter(Boolean);
  return admins.indexOf(String(email || '').toLowerCase().trim()) >= 0;
}

function findEmployeeMasterRecord_(spreadsheet, employeeId) {
  var sheetNames = ['Employee Master - FA', 'Employee Master - FR', 'Employee Master - SA'];
  var matches = [];
  sheetNames.forEach(function (sheetName) {
    var sheet = requireSheet_(spreadsheet, sheetName);
    var rowCount = Math.max(sheet.getLastRow() - 4, 0);
    if (!rowCount) return;
    sheet.getRange(5, 1, rowCount, 1).getDisplayValues().forEach(function (row, index) {
      if (String(row[0] || '').trim() === employeeId) {
        matches.push({ sheet: sheet, rowNumber: index + 5 });
      }
    });
  });
  if (matches.length > 1) throw new Error('Duplicate employee IDs were found in the employee masters.');
  return matches[0] || null;
}

function getMaskedSensitiveFields_(headers, row) {
  var fields = [];
  headers.forEach(function (header, index) {
    if (!isSensitiveHeader_(header)) return;
    fields.push({
      columnNumber: index + 1,
      label: String(header || '').trim(),
      maskedValue: maskSensitiveValue_(row[index], header)
    });
  });
  return fields;
}

function isSensitiveHeader_(header) {
  var normalized = String(header || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /PAN|PERMANENTACCOUNT|AADHAAR|ADHAAR|UIDAI|UNIVERSALACCOUNT|UAN|BANK|ACCOUNT|ACCT|IFSC|MOBILE|PHONE|EMAIL|ADDRESS|DATEOFBIRTH|BIRTHDATE|DOB/.test(normalized);
}

function maskSensitiveValue_(value, header) {
  var normalizedHeader = String(header || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (value instanceof Date || /ADDRESS|EMAIL|DATEOFBIRTH|BIRTHDATE|DOB|IFSC/.test(normalizedHeader)
      || (/BANK/.test(normalizedHeader) && !/ACCOUNT|ACCT|A\/C/.test(normalizedHeader))) return '••••';
  var text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return 'Not recorded';
  var suffix = text.replace(/\s/g, '').slice(-4);
  return '••••' + suffix;
}

function findBirthDateColumn_(headers) {
  for (var index = 0; index < headers.length; index += 1) {
    var normalized = String(headers[index] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/DATEOFBIRTH|BIRTHDATE|DOB/.test(normalized)) return index;
  }
  return -1;
}

function ageAtJoining_(birthDate, joiningDate) {
  if (!(birthDate instanceof Date) || isNaN(birthDate.getTime())
      || !(joiningDate instanceof Date) || isNaN(joiningDate.getTime())
      || joiningDate < birthDate) return null;
  var age = joiningDate.getFullYear() - birthDate.getFullYear();
  var beforeBirthday = joiningDate.getMonth() < birthDate.getMonth()
    || (joiningDate.getMonth() === birthDate.getMonth() && joiningDate.getDate() < birthDate.getDate());
  return beforeBirthday ? age - 1 : age;
}

function requireHeaders_(sheet, rowNumber, expectedHeaders) {
  Object.keys(expectedHeaders).forEach(function (columnNumber) {
    var actual = String(sheet.getRange(rowNumber, Number(columnNumber)).getDisplayValue() || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '');
    var expected = String(expectedHeaders[columnNumber]).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (actual.indexOf(expected) < 0) {
      throw new Error('The ' + sheet.getName() + ' tab has an unexpected header at row ' + rowNumber + ', column ' + columnNumber + '. Verify the workbook structure before using the portal.');
    }
  });
}

function readAttendance_(spreadsheet, employeeById, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Attendance');
  requireHeaders_(sheet, 4, { 1: 'EMP ID', 4: 'WORK DAYS', 6: 'LEAVE DAYS THIS MONTH', 7: 'LONGEST CONTINUOUS SPELL', 12: 'PROCESS ALLOWANCE', 14: 'PUNCTUAL INCENTIVE', 15: 'FULL ATT. BONUS', 18: 'TOTAL LATE DAYS' });
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  var result = Object.create(null);
  if (!rowCount) return result;
  var values = sheet.getRange(5, 1, rowCount, 26).getValues();
  values.forEach(function (row, index) {
    var id = String(row[0] || '').trim();
    if (!id || !employeeById[id]) return;
    if (result[id]) throw new Error('The Attendance sheet contains duplicate employee IDs. Correct it before using the portal.');
    result[id] = {
      workDays: amountOrNull_(row[3], 'Attendance', index + 5, warnings),
      lopAmount: amountOrNull_(row[4], 'Attendance', index + 5, warnings),
      leaveDays: amountOrNull_(row[5], 'Attendance', index + 5, warnings),
      longestContinuousSpell: amountOrNull_(row[6], 'Attendance', index + 5, warnings),
      clBalanceBefore: amountOrNull_(row[7], 'Attendance', index + 5, warnings),
      elBalanceBefore: amountOrNull_(row[8], 'Attendance', index + 5, warnings),
      clUsed: amountOrNull_(row[9], 'Attendance', index + 5, warnings),
      elUsed: amountOrNull_(row[10], 'Attendance', index + 5, warnings),
      processAllowance: amountOrNull_(row[11], 'Attendance', index + 5, warnings),
      lopDays: amountOrNull_(row[12], 'Attendance', index + 5, warnings),
      punctualIncentive: amountOrNull_(row[13], 'Attendance', index + 5, warnings),
      fullAttendanceBonus: amountOrNull_(row[14], 'Attendance', index + 5, warnings),
      totalLateDays: amountOrNull_(row[17], 'Attendance', index + 5, warnings),
      lateDeductionDays: amountOrNull_(row[18], 'Attendance', index + 5, warnings),
      clUsedForLate: amountOrNull_(row[19], 'Attendance', index + 5, warnings),
      elUsedForLate: amountOrNull_(row[20], 'Attendance', index + 5, warnings),
      salaryDeductionDays: amountOrNull_(row[21], 'Attendance', index + 5, warnings),
      lateAttendanceDeduction: amountOrNull_(row[22], 'Attendance', index + 5, warnings),
      lateAttendanceDescription: String(row[23] || ''),
      totalClUsed: amountOrNull_(row[24], 'Attendance', index + 5, warnings),
      totalElUsed: amountOrNull_(row[25], 'Attendance', index + 5, warnings)
    };
  });
  return result;
}

function readLeaveBalances_(spreadsheet, employeeById, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Leave Master');
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  var result = Object.create(null);
  if (!rowCount) return result;
  sheet.getRange(5, 1, rowCount, 9).getValues().forEach(function (row, index) {
    var id = String(row[0] || '').trim();
    if (!id || !employeeById[id]) return;
    result[id] = {
      elEntitlement: amountOrNull_(row[3], 'Leave Master', index + 5, warnings),
      elTaken: amountOrNull_(row[4], 'Leave Master', index + 5, warnings),
      elBalance: amountOrNull_(row[5], 'Leave Master', index + 5, warnings),
      clEntitlement: amountOrNull_(row[6], 'Leave Master', index + 5, warnings),
      clTaken: amountOrNull_(row[7], 'Leave Master', index + 5, warnings),
      clBalance: amountOrNull_(row[8], 'Leave Master', index + 5, warnings)
    };
  });
  return result;
}

function readSalaryRegister_(spreadsheet, employeeById, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Salary Register');
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  var result = Object.create(null);
  if (!rowCount) return result;
  sheet.getRange(5, 1, rowCount, 10).getValues().forEach(function (row, index) {
    var id = String(row[0] || '').trim();
    if (!id || !employeeById[id]) return;
    if (result[id]) throw new Error('The Salary Register contains duplicate employee IDs. Correct it before using payroll preview.');
    result[id] = {
      basicTotal: amountOrNull_(row[3], 'Salary Register', index + 5, warnings),
      grossSalary: amountOrNull_(row[4], 'Salary Register', index + 5, warnings),
      employeePf: amountOrNull_(row[5], 'Salary Register', index + 5, warnings),
      employeeEsi: amountOrNull_(row[6], 'Salary Register', index + 5, warnings),
      totalDeductions: amountOrNull_(row[7], 'Salary Register', index + 5, warnings),
      netPayable: amountOrNull_(row[8], 'Salary Register', index + 5, warnings)
    };
  });
  return result;
}

function summarizeCompanies_(companies, employees, salaryById) {
  return companies.map(function (company) {
    var members = employees.filter(function (employee) { return employee.companyId === company.id; });
    var result = { companyId: company.id, employeeCount: members.length, basicTotal: 0, grossSalary: 0, employeePf: 0, employeeEsi: 0, totalDeductions: 0, netPayable: 0, formulaIssues: 0 };
    members.forEach(function (employee) {
      var salary = salaryById[employee.id];
      if (!salary) {
        result.formulaIssues += 1;
        return;
      }
      ['basicTotal', 'grossSalary', 'employeePf', 'employeeEsi', 'totalDeductions', 'netPayable'].forEach(function (field) {
        if (salary[field] === null) result.formulaIssues += 1;
        else result[field] += salary[field];
      });
    });
    if (result.formulaIssues) {
      ['basicTotal', 'grossSalary', 'employeePf', 'employeeEsi', 'totalDeductions', 'netPayable'].forEach(function (field) {
        result[field] = null;
      });
    }
    return result;
  });
}

function readPayrollHistory_(spreadsheet, companies, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Payroll History');
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  if (!rowCount) return [];
  var values = sheet.getRange(5, 1, rowCount, 21).getValues();
  var grouped = Object.create(null);
  values.forEach(function (row, index) {
    var month = String(row[0] || '').trim();
    var id = String(row[1] || '').trim();
    if (!month || !id) return;
    var companyText = String(row[3] || '').toLowerCase();
    var company = companyText.indexOf('flavor') >= 0
      ? companies[0]
      : (companyText.indexOf('supreme') >= 0 ? companies[1] : null);
    if (!company) {
      warnings.push('Payroll History row ' + (index + 5) + ' has an unrecognized company label.');
      return;
    }
    var key = month + '|' + company.id;
    if (!grouped[key]) {
      grouped[key] = {
        id: 'HISTORY-' + String(index + 5),
        period: month,
        companyId: company.id,
        companyLabel: company.name,
        employeeIds: [],
        total: 0,
        status: 'Archived',
        createdAt: ''
      };
    }
    grouped[key].employeeIds.push(id);
    var gross = amountOrNull_(row[10], 'Payroll History', index + 5, warnings);
    if (gross !== null) grouped[key].total += gross;
  });
  return Object.keys(grouped).map(function (key) { return grouped[key]; }).reverse().slice(0, 30);
}

function readCompanyReports_(spreadsheet, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Reports');
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  if (!rowCount) return [];
  return sheet.getRange(5, 1, rowCount, 10).getValues().filter(function (row) {
    return String(row[0] || '').trim() && String(row[0]).toUpperCase() !== 'GRAND TOTAL';
  }).map(function (row, index) {
    var sourceCompany = String(row[0] || '');
    var lowerCompany = sourceCompany.toLowerCase();
    var companyName = lowerCompany.indexOf('flavor') >= 0
      ? 'THE FLAVORS INDIA PVT LTD'
      : (lowerCompany.indexOf('supreme') >= 0 ? 'THE SUPREME AROMATICS PVT LTD' : 'Unrecognized company group');
    if (companyName === 'Unrecognized company group') {
      warnings.push('Reports row ' + (index + 5) + ' has an unrecognized company label.');
    }
    var groupType = lowerCompany.indexOf('retainer') >= 0 ? 'Retainer staff' : 'Active staff';
    return {
      company: sourceCompany,
      companyLabel: companyName + ' · ' + groupType,
      employees: amountOrNull_(row[1], 'Reports', index + 5, warnings),
      grossSalary: amountOrNull_(row[2], 'Reports', index + 5, warnings),
      employeePf: amountOrNull_(row[3], 'Reports', index + 5, warnings),
      employeeEsi: amountOrNull_(row[4], 'Reports', index + 5, warnings),
      totalDeductions: amountOrNull_(row[5], 'Reports', index + 5, warnings),
      netPayable: amountOrNull_(row[6], 'Reports', index + 5, warnings),
      annualBonus: amountOrNull_(row[7], 'Reports', index + 5, warnings),
      gratuityEstimate: amountOrNull_(row[8], 'Reports', index + 5, warnings),
      annualTds: amountOrNull_(row[9], 'Reports', index + 5, warnings)
    };
  });
}

function readAdvances_(spreadsheet, employeeById, warnings) {
  var sheet = requireSheet_(spreadsheet, 'Advance & Loan');
  var rowCount = Math.max(sheet.getLastRow() - 4, 0);
  if (!rowCount) return [];
  return sheet.getRange(5, 1, rowCount, 11).getValues().filter(function (row) {
    return String(row[0] || '').trim() && employeeById[String(row[0]).trim()];
  }).map(function (row, index) {
    return {
      employeeId: String(row[0]).trim(),
      name: String(row[1] || ''),
      companyId: employeeById[String(row[0]).trim()].companyId,
      type: String(row[3] || ''),
      openingBalance: amountOrNull_(row[4], 'Advance & Loan', index + 5, warnings),
      monthlyDeduction: amountOrNull_(row[5], 'Advance & Loan', index + 5, warnings),
      recovered: amountOrNull_(row[6], 'Advance & Loan', index + 5, warnings),
      currentBalance: amountOrNull_(row[7], 'Advance & Loan', index + 5, warnings),
      nextDeduction: amountOrNull_(row[8], 'Advance & Loan', index + 5, warnings),
      balanceAfterNextDeduction: amountOrNull_(row[9], 'Advance & Loan', index + 5, warnings)
    };
  });
}

function parsePayrollPeriod_(value, displayValue) {
  var text = String(displayValue || value || '').trim();
  var match = text.match(/\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(20\d{2})\b/i);
  if (match) {
    var monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    var month = monthNames.indexOf(match[1].toLowerCase()) + 1;
    return { value: match[2] + '-' + String(month).padStart(2, '0'), label: match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() + ' ' + match[2] };
  }
  if (value instanceof Date && !isNaN(value.getTime())) {
    var timezone = Session.getScriptTimeZone();
    return {
      value: Utilities.formatDate(value, timezone, 'yyyy-MM'),
      label: Utilities.formatDate(value, timezone, 'MMMM yyyy')
    };
  }
  throw new Error('Settings!B4 must contain a valid payroll month such as SEPTEMBER 2026.');
}

function calendarDaysInPeriod_(period) {
  var match = String(period || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) throw new Error('The payroll period is invalid; verify Settings!B4 before continuing.');
  return new Date(Number(match[1]), Number(match[2]), 0).getDate();
}

function requireMatchingCalendarDays_(settings, payrollPeriod) {
  var calendarDays = Number(settings.getRange('B5').getValue());
  var expectedCalendarDays = calendarDaysInPeriod_(payrollPeriod.value);
  if (!Number.isInteger(calendarDays) || calendarDays !== expectedCalendarDays) {
    throw new Error('Settings!B5 must match the ' + expectedCalendarDays + ' calendar days in ' + payrollPeriod.label + '. Correct the workbook setting before previewing payroll or editing attendance.');
  }
  return calendarDays;
}

function amountOrNull_(value, sheetName, rowNumber, warnings) {
  if (value === '' || value === null || value === undefined) return 0;
  if (typeof value === 'number' && isFinite(value)) return value;
  var text = String(value).trim();
  if (/^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/i.test(text)) {
    warnings.push(sheetName + '!row ' + rowNumber + ' contains a spreadsheet formula error. Review the source before payroll.');
    return null;
  }
  var parsed = Number(text.replace(/[₹,\s]/g, ''));
  if (isFinite(parsed)) return parsed;
  warnings.push(sheetName + '!row ' + rowNumber + ' contains a non-numeric payroll value.');
  return null;
}

function requiredAmount_(value, sheetName, rowNumber, columnNumber) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (value === '' || value === null || value === undefined) return 0;
  throw new Error(sheetName + ' row ' + rowNumber + ' column ' + columnNumber + ' is not a valid calculated amount. Correct the formula or value before previewing payroll.');
}

function integerOrNull_(value, label, warnings) {
  var amount = amountOrNull_(value, label, 1, warnings);
  return amount === null ? null : Math.trunc(amount);
}

function validateNonnegativeInteger_(value, name, max) {
  var number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error(name + ' must be a whole number between 0 and ' + max + '.');
  }
  return number;
}

function normalizeStatus_(status) {
  var normalized = String(status || '').trim().toLowerCase();
  if (!normalized || normalized === 'active') return 'active';
  if (normalized.indexOf('leave') >= 0) return 'on-leave';
  return 'inactive';
}

function formatDate_(value, spreadsheet) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

function initials_(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(function (part) {
    return part.charAt(0).toUpperCase();
  }).join('');
}

function emptyAttendance_() {
  return {
    workDays: 0, lopAmount: 0, leaveDays: 0, longestContinuousSpell: 0,
    clBalanceBefore: 0, elBalanceBefore: 0, clUsed: 0, elUsed: 0,
    processAllowance: 0, lopDays: 0, punctualIncentive: 0, fullAttendanceBonus: 0,
    totalLateDays: 0, lateDeductionDays: 0, clUsedForLate: 0, elUsedForLate: 0,
    salaryDeductionDays: 0, lateAttendanceDeduction: 0, lateAttendanceDescription: '',
    totalClUsed: 0, totalElUsed: 0
  };
}

function emptyLeaveBalance_() {
  return { elEntitlement: 0, elTaken: 0, elBalance: 0, clEntitlement: 0, clTaken: 0, clBalance: 0 };
}
