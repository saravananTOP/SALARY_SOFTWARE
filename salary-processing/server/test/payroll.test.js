'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateLeave, calculatePayroll, completedYears } = require('../lib/payroll');

const settings = {
    calendarDays: 30,
    maxContinuousClDays: 3,
    pfWageCeiling: 25000,
    pfEmployeeRate: 0.12,
    epsEmployerRate: 0.0833,
    epsEmployerCap: 1250,
    esiEmployeeRate: 0.0075,
    esiEmployerRate: 0.0325,
    standardDeduction: 75000,
    bonusWageCeiling: 7000,
    bonusRate: 0.0833,
    gratuityDaysPerYear: 15,
    gratuityMinimumYears: 5,
    asOfDate: '2026-09-30',
    taxSlabs: [
        { lowerBound: 0, upperBound: 400000, rate: 0 },
        { lowerBound: 400000, upperBound: 800000, rate: 0.05 },
        { lowerBound: 800000, upperBound: 1200000, rate: 0.1 },
        { lowerBound: 1200000, upperBound: null, rate: 0.15 }
    ]
};

test('continuous leave beyond the CL limit is charged to EL before LOP', () => {
    assert.deepEqual(allocateLeave({
        leaveDays: 5,
        longestContinuousSpell: 5,
        clBalance: 10,
        elBalance: 10,
        maxContinuousClDays: 3
    }), { clUsed: 3, elUsed: 2, lopDays: 0 });
});

test('leave left after exhausting CL and EL becomes LOP', () => {
    assert.deepEqual(allocateLeave({
        leaveDays: 8,
        longestContinuousSpell: 5,
        clBalance: 2,
        elBalance: 3,
        maxContinuousClDays: 3
    }), { clUsed: 2, elUsed: 3, lopDays: 3 });
});

test('payroll applies LOP, prorated fixed allowance, PF/ESI, bonus, and gratuity rules', () => {
    const result = calculatePayroll({
        basicSalary: 30000,
        fixedAllowance: 3000,
        perDayRate: 100,
        pfApplicable: true,
        esiExempt: false,
        esiCoverageStatus: 'Y',
        staffType: 'active',
        elBalance: 10,
        clBalance: 10,
        healthInsurance: 0,
        licDeduction: 0,
        joiningDate: '2019-01-01'
    }, {
        workDays: 25,
        leaveDays: 0,
        longestContinuousSpell: 0,
        processAllowance: 100,
        punctualIncentive: 50,
        fullAttendanceBonus: 50
    }, settings);

    assert.equal(result.basicTotal, 30000);
    assert.equal(result.hra, 3000);
    assert.equal(result.fixedAllowance, 2500);
    assert.equal(result.ltwAllowance, 2500);
    assert.equal(result.grossSalary, 38200);
    assert.equal(result.pfWage, 25000);
    assert.equal(result.employeePf, 3000);
    assert.equal(result.employerEps, 1250);
    assert.equal(result.employerEpf, 1750);
    assert.equal(result.employeeEsi, 287);
    assert.equal(result.employerEsi, 1242);
    assert.equal(result.netPayable, 34913);
    assert.equal(result.annualBonusEstimate, 6997);
    assert.equal(result.completedServiceYears, 7);
    assert.equal(result.gratuityEstimate, 121154);
});

test('a covered employee remains eligible for ESI when a monthly gross exceeds the wage ceiling', () => {
    const employee = {
        basicSalary: 50000,
        fixedAllowance: 0,
        perDayRate: 0,
        pfApplicable: false,
        esiExempt: false,
        esiCoverageStatus: 'Y',
        staffType: 'active',
        elBalance: 0,
        clBalance: 0,
        healthInsurance: 0,
        licDeduction: 0,
        joiningDate: null
    };
    const result = calculatePayroll(employee, {
        workDays: 30,
        leaveDays: 0,
        longestContinuousSpell: 0,
        processAllowance: 0,
        punctualIncentive: 0,
        fullAttendanceBonus: 0
    }, settings);

    assert.equal(result.grossSalary, 55000);
    assert.equal(result.employeeEsi, 413);
});

test('service years are counted only after a full anniversary', () => {
    assert.equal(completedYears('2020-09-30', '2026-09-29'), 5);
    assert.equal(completedYears('2020-09-30', '2026-09-30'), 6);
});
