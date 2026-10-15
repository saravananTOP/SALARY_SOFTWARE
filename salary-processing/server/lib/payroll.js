'use strict';

function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundWhole(value) {
    return Math.round(value + Number.EPSILON);
}

function requireFiniteNonnegative(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative number.`);
    }
    return number;
}

function allocateLeave({
    leaveDays,
    longestContinuousSpell,
    clBalance,
    elBalance,
    maxContinuousClDays
}) {
    const leave = requireFiniteNonnegative(leaveDays, 'Leave days');
    const longestSpell = requireFiniteNonnegative(longestContinuousSpell, 'Longest continuous spell');
    const cl = requireFiniteNonnegative(clBalance, 'CL balance');
    const el = requireFiniteNonnegative(elBalance, 'EL balance');
    const maxClSpell = requireFiniteNonnegative(maxContinuousClDays, 'Maximum continuous CL days');
    if (longestSpell > leave) throw new RangeError('Longest continuous spell cannot exceed total leave days.');

    const forcedEl = Math.max(longestSpell - maxClSpell, 0);
    const clEligible = Math.max(leave - forcedEl, 0);
    const clUsed = Math.min(clEligible, cl);
    const elUsed = Math.min(Math.max(leave - clUsed, 0), el);
    const lopDays = Math.max(leave - clUsed - elUsed, 0);
    return { clUsed, elUsed, lopDays };
}

function calculateIncomeTax(annualizedGross, standardDeduction, slabs) {
    const taxableIncome = Math.max(0, annualizedGross - standardDeduction);
    let tax = 0;
    for (const slab of slabs) {
        const lower = requireFiniteNonnegative(slab.lowerBound, 'Tax slab lower bound');
        const upper = slab.upperBound == null ? Infinity : requireFiniteNonnegative(slab.upperBound, 'Tax slab upper bound');
        const rate = Number(slab.rate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 1 || upper <= lower) {
            throw new TypeError('Income tax slabs are invalid.');
        }
        tax += Math.max(0, Math.min(taxableIncome, upper) - lower) * rate;
    }
    const annualTax = roundWhole(tax);
    const cess = roundWhole(annualTax * 0.04);
    return { taxableIncome, annualTax, cess, totalAnnualTax: annualTax + cess };
}

function calculatePayroll(employee, attendance, settings, advances = []) {
    const calendarDays = requireFiniteNonnegative(settings.calendarDays, 'Calendar days');
    if (calendarDays < 1 || calendarDays > 31) throw new RangeError('Calendar days must be from 1 to 31.');
    const workDays = requireFiniteNonnegative(attendance.workDays, 'Work days');
    const leaveDays = requireFiniteNonnegative(attendance.leaveDays, 'Leave days');
    const continuousSpell = requireFiniteNonnegative(attendance.longestContinuousSpell, 'Longest continuous spell');
    if (workDays + leaveDays > calendarDays) {
        throw new RangeError('Work days plus leave days cannot exceed calendar days.');
    }

    const leave = allocateLeave({
        leaveDays,
        longestContinuousSpell: continuousSpell,
        clBalance: employee.clBalance,
        elBalance: employee.elBalance,
        maxContinuousClDays: settings.maxContinuousClDays
    });
    const lopAmount = roundMoney(leave.lopDays * requireFiniteNonnegative(employee.basicSalary, 'Basic salary') / 30);
    const basicTotal = roundWhole(Math.max(0, employee.basicSalary - lopAmount));
    const hra = roundWhole(basicTotal * 0.10);
    const fixedAllowance = roundWhole(
        requireFiniteNonnegative(employee.fixedAllowance, 'Fixed allowance') * workDays / calendarDays
    );
    const ltwAllowance = roundWhole(requireFiniteNonnegative(employee.perDayRate, 'Per-day rate') * workDays);
    const processAllowance = roundWhole(requireFiniteNonnegative(attendance.processAllowance || 0, 'Process allowance'));
    const punctualIncentive = roundWhole(requireFiniteNonnegative(attendance.punctualIncentive || 0, 'Punctual incentive'));
    const fullAttendanceBonus = roundWhole(requireFiniteNonnegative(attendance.fullAttendanceBonus || 0, 'Full-attendance bonus'));
    const punctualTotal = punctualIncentive + fullAttendanceBonus;
    const grossSalary = basicTotal + hra + fixedAllowance + ltwAllowance + processAllowance + punctualTotal;

    const pfWage = Math.min(basicTotal, requireFiniteNonnegative(settings.pfWageCeiling, 'PF wage ceiling'));
    const employeePf = employee.pfApplicable ? roundWhole(pfWage * settings.pfEmployeeRate) : 0;
    const employerEps = employee.pfApplicable && employee.staffType === 'active'
        ? Math.min(roundWhole(pfWage * settings.epsEmployerRate), settings.epsEmployerCap)
        : 0;
    const employerEpf = employee.pfApplicable ? Math.max(employeePf - employerEps, 0) : 0;
    const esiCovered = employee.esiCoverageStatus === 'Y' && !employee.esiExempt;
    const employeeEsi = esiCovered ? roundWhole(grossSalary * settings.esiEmployeeRate) : 0;
    const employerEsi = esiCovered ? roundWhole(grossSalary * settings.esiEmployerRate) : 0;

    const regularAdvance = advances
        .filter((advance) => advance.advanceType === 'regular')
        .reduce((sum, advance) => sum + Math.min(advance.currentBalance, advance.monthlyDeduction), 0);
    const schoolAdvance = advances
        .filter((advance) => advance.advanceType === 'school')
        .reduce((sum, advance) => sum + Math.min(advance.currentBalance, advance.monthlyDeduction), 0);
    const healthInsurance = requireFiniteNonnegative(employee.healthInsurance || 0, 'Health insurance');
    const licDeduction = requireFiniteNonnegative(employee.licDeduction || 0, 'LIC deduction');
    const totalDeductions = employeePf + employeeEsi + regularAdvance + schoolAdvance + healthInsurance + licDeduction;
    const netPayable = grossSalary - totalDeductions;

    const tax = calculateIncomeTax(
        grossSalary * 12,
        settings.standardDeduction,
        settings.taxSlabs
    );
    const bonus = roundWhole(
        Math.min(basicTotal, settings.bonusWageCeiling) * settings.bonusRate * 12
    );
    const gratuityYears = employee.joiningDate ? completedYears(employee.joiningDate, settings.asOfDate) : 0;
    const gratuity = gratuityYears >= settings.gratuityMinimumYears
        ? roundWhole((settings.gratuityDaysPerYear / 26) * basicTotal * gratuityYears)
        : 0;

    return {
        workDays,
        leaveDays,
        ...leave,
        lopAmount,
        basicTotal,
        hra,
        fixedAllowance,
        ltwAllowance,
        processAllowance,
        punctualTotal,
        grossSalary,
        pfWage,
        employeePf,
        employerEps,
        employerEpf,
        employeeEsi,
        employerEsi,
        regularAdvance,
        schoolAdvance,
        healthInsurance,
        licDeduction,
        totalDeductions,
        netPayable,
        annualBonusEstimate: bonus,
        completedServiceYears: gratuityYears,
        gratuityEstimate: gratuity,
        annualizedGross: grossSalary * 12,
        taxableIncome: tax.taxableIncome,
        annualTdsEstimate: tax.totalAnnualTax
    };
}

function completedYears(joiningDate, asOfDate) {
    const start = new Date(`${joiningDate}T00:00:00Z`);
    const end = new Date(`${asOfDate}T00:00:00Z`);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start) return 0;
    let years = end.getUTCFullYear() - start.getUTCFullYear();
    if (end.getUTCMonth() < start.getUTCMonth()
        || (end.getUTCMonth() === start.getUTCMonth() && end.getUTCDate() < start.getUTCDate())) {
        years--;
    }
    return years;
}

module.exports = { allocateLeave, calculateIncomeTax, calculatePayroll, completedYears };
