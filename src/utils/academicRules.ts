export interface GradingTier {
  grade: string;
  minPercentage: number;
  maxPercentage: number;
  label: string;
  gpa: number;
}

export const DEFAULT_GRADING_SCALE: GradingTier[] = [
  { grade: 'A+', minPercentage: 90, maxPercentage: 100, label: 'Outstanding', gpa: 4.0 },
  { grade: 'A', minPercentage: 80, maxPercentage: 89.99, label: 'Excellent', gpa: 3.7 },
  { grade: 'B+', minPercentage: 70, maxPercentage: 79.99, label: 'Very Good', gpa: 3.3 },
  { grade: 'B', minPercentage: 60, maxPercentage: 69.99, label: 'Good', gpa: 3.0 },
  { grade: 'C', minPercentage: 50, maxPercentage: 59.99, label: 'Satisfactory', gpa: 2.0 },
  { grade: 'D', minPercentage: 40, maxPercentage: 49.99, label: 'Pass', gpa: 1.0 },
  { grade: 'F', minPercentage: 0, maxPercentage: 39.99, label: 'Fail', gpa: 0.0 }
];

export interface MarkCalculationInput {
  obtainedMarks: number;
  maxMarks: number;
  passMarks: number;
  gradingScale?: GradingTier[];
}

export interface MarkCalculationResult {
  obtainedMarks: number;
  maxMarks: number;
  passMarks: number;
  percentage: number;
  grade: string;
  gradeLabel: string;
  gpa: number;
  passed: boolean;
}

export function validateMarkBounds(obtainedMarks: number, maxMarks: number, passMarks: number): { valid: boolean; error?: string } {
  if (typeof maxMarks !== 'number' || Number.isNaN(maxMarks) || maxMarks <= 0 || maxMarks > 1000) {
    return { valid: false, error: 'Maximum marks must be between 1 and 1000.' };
  }
  if (typeof passMarks !== 'number' || Number.isNaN(passMarks) || passMarks < 0 || passMarks > maxMarks) {
    return { valid: false, error: 'Pass marks must be between 0 and maximum marks.' };
  }
  if (typeof obtainedMarks !== 'number' || Number.isNaN(obtainedMarks)) {
    return { valid: false, error: 'Obtained marks must be a valid number.' };
  }
  if (obtainedMarks < 0) {
    return { valid: false, error: 'Obtained marks cannot be negative.' };
  }
  if (obtainedMarks > maxMarks) {
    return { valid: false, error: `Obtained marks (${obtainedMarks}) cannot exceed maximum marks (${maxMarks}).` };
  }
  return { valid: true };
}

export function calculateSubjectResult(input: MarkCalculationInput): MarkCalculationResult {
  const check = validateMarkBounds(input.obtainedMarks, input.maxMarks, input.passMarks);
  if (!check.valid) {
    throw new Error(check.error);
  }
  const scale = input.gradingScale && input.gradingScale.length > 0 ? input.gradingScale : DEFAULT_GRADING_SCALE;
  const rawPct = (input.obtainedMarks / input.maxMarks) * 100;
  const percentage = Math.round(rawPct * 100) / 100;
  const passed = input.obtainedMarks >= input.passMarks;

  if (!passed) {
    return {
      obtainedMarks: input.obtainedMarks,
      maxMarks: input.maxMarks,
      passMarks: input.passMarks,
      percentage,
      grade: 'F',
      gradeLabel: 'Fail',
      gpa: 0.0,
      passed: false
    };
  }

  const sortedScale = [...scale].sort((a, b) => b.minPercentage - a.minPercentage);
  const matched = sortedScale.find((tier) => percentage >= tier.minPercentage) || sortedScale[sortedScale.length - 1];

  return {
    obtainedMarks: input.obtainedMarks,
    maxMarks: input.maxMarks,
    passMarks: input.passMarks,
    percentage,
    grade: matched.grade,
    gradeLabel: matched.label,
    gpa: matched.gpa,
    passed: true
  };
}

export function calculateAggregateMarksheet(
  subjectMarks: MarkCalculationInput[],
  gradingScale: GradingTier[] = DEFAULT_GRADING_SCALE
) {
  if (!subjectMarks.length) {
    return {
      totalMaxMarks: 0,
      totalPassMarks: 0,
      totalObtainedMarks: 0,
      percentage: 0,
      grade: 'N/A',
      gradeLabel: 'No Entries',
      gpa: 0,
      passed: false,
      subjectCount: 0,
      failedSubjectsCount: 0
    };
  }

  let totalMaxMarks = 0;
  let totalPassMarks = 0;
  let totalObtainedMarks = 0;
  let failedSubjectsCount = 0;

  for (const item of subjectMarks) {
    const res = calculateSubjectResult({ ...item, gradingScale });
    totalMaxMarks += res.maxMarks;
    totalPassMarks += res.passMarks;
    totalObtainedMarks += res.obtainedMarks;
    if (!res.passed) {
      failedSubjectsCount += 1;
    }
  }

  const percentage = totalMaxMarks > 0 ? Math.round(((totalObtainedMarks / totalMaxMarks) * 100) * 100) / 100 : 0;
  const passed = failedSubjectsCount === 0 && totalObtainedMarks >= totalPassMarks;

  if (!passed) {
    return {
      totalMaxMarks,
      totalPassMarks,
      totalObtainedMarks,
      percentage,
      grade: 'F',
      gradeLabel: 'Fail',
      gpa: 0.0,
      passed: false,
      subjectCount: subjectMarks.length,
      failedSubjectsCount
    };
  }

  const sortedScale = [...gradingScale].sort((a, b) => b.minPercentage - a.minPercentage);
  const matched = sortedScale.find((tier) => percentage >= tier.minPercentage) || sortedScale[sortedScale.length - 1];

  return {
    totalMaxMarks,
    totalPassMarks,
    totalObtainedMarks,
    percentage,
    grade: matched.grade,
    gradeLabel: matched.label,
    gpa: matched.gpa,
    passed: true,
    subjectCount: subjectMarks.length,
    failedSubjectsCount: 0
  };
}

export interface StudentUniquenessCandidate {
  id?: string;
  admissionNo: string;
  rollNo: string;
  classId: string;
  sectionId: string;
}

export function validateStudentUniqueness(
  candidate: StudentUniquenessCandidate,
  existingStudents: StudentUniquenessCandidate[]
): { valid: boolean; error?: string } {
  const normAdm = candidate.admissionNo.trim().toUpperCase();
  const normRoll = candidate.rollNo.trim().toUpperCase();

  if (!normAdm) {
    return { valid: false, error: 'Admission Number is required.' };
  }
  if (!normRoll) {
    return { valid: false, error: 'Roll Number is required.' };
  }

  for (const stu of existingStudents) {
    if (candidate.id && stu.id === candidate.id) continue;
    if (stu.admissionNo.trim().toUpperCase() === normAdm) {
      return {
        valid: false,
        error: `Admission Number "${candidate.admissionNo}" is already assigned to another student.`
      };
    }
    if (
      stu.classId === candidate.classId &&
      stu.sectionId === candidate.sectionId &&
      stu.rollNo.trim().toUpperCase() === normRoll
    ) {
      return {
        valid: false,
        error: `Roll Number "${candidate.rollNo}" is already assigned in this Class and Section.`
      };
    }
  }

  return { valid: true };
}
