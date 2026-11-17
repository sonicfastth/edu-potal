import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarkBounds,
  calculateSubjectResult,
  calculateAggregateMarksheet,
  validateStudentUniqueness
} from './academicRules';

test('validateMarkBounds rejects marks exceeding maximum or negative', () => {
  assert.equal(validateMarkBounds(88, 100, 40).valid, true);
  assert.equal(validateMarkBounds(105, 100, 40).valid, false);
  assert.equal(validateMarkBounds(-5, 100, 40).valid, false);
  assert.equal(validateMarkBounds(50, 0, 40).valid, false);
});

test('calculateSubjectResult computes percentage, grade, and pass/fail accurately', () => {
  const resPass = calculateSubjectResult({ obtainedMarks: 92, maxMarks: 100, passMarks: 40 });
  assert.equal(resPass.percentage, 92);
  assert.equal(resPass.grade, 'A+');
  assert.equal(resPass.passed, true);

  const resFail = calculateSubjectResult({ obtainedMarks: 34, maxMarks: 100, passMarks: 40 });
  assert.equal(resFail.percentage, 34);
  assert.equal(resFail.grade, 'F');
  assert.equal(resFail.passed, false);
});

test('calculateAggregateMarksheet marks overall fail if any single subject fails', () => {
  const summary = calculateAggregateMarksheet([
    { obtainedMarks: 95, maxMarks: 100, passMarks: 40 },
    { obtainedMarks: 90, maxMarks: 100, passMarks: 40 },
    { obtainedMarks: 32, maxMarks: 100, passMarks: 40 }
  ]);
  assert.equal(summary.totalObtainedMarks, 217);
  assert.equal(summary.totalMaxMarks, 300);
  assert.equal(summary.passed, false);
  assert.equal(summary.grade, 'F');
  assert.equal(summary.failedSubjectsCount, 1);
});

test('validateStudentUniqueness enforces global admissionNo and class/section rollNo uniqueness', () => {
  const existing = [
    { id: 'stu-1', admissionNo: 'DHBC-2026-001', rollNo: '01', classId: 'cls-10', sectionId: 'sec-a' },
    { id: 'stu-2', admissionNo: 'DHBC-2026-002', rollNo: '02', classId: 'cls-10', sectionId: 'sec-a' }
  ];

  // Duplicate admission number across any class fails
  const dupAdm = validateStudentUniqueness(
    { admissionNo: 'dhbc-2026-001', rollNo: '05', classId: 'cls-9', sectionId: 'sec-b' },
    existing
  );
  assert.equal(dupAdm.valid, false);

  // Duplicate roll number in same class & section fails
  const dupRoll = validateStudentUniqueness(
    { admissionNo: 'DHBC-2026-009', rollNo: '01', classId: 'cls-10', sectionId: 'sec-a' },
    existing
  );
  assert.equal(dupRoll.valid, false);

  // Same roll number in a DIFFERENT section succeeds
  const diffSectionRoll = validateStudentUniqueness(
    { admissionNo: 'DHBC-2026-009', rollNo: '01', classId: 'cls-10', sectionId: 'sec-b' },
    existing
  );
  assert.equal(diffSectionRoll.valid, true);
});
