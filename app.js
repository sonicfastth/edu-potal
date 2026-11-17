/**
 * EDU CORE — DARUL HUDA BENGAL CAMPUS
 * FILE 3: app.js
 *
 * Complete Production Application Logic:
 * - Role-Based Username/Password Authentication (Admin, Teacher, Student)
 * - Initial Admin Provisioning & Instant Non-Blocking Dashboard Access
 * - Supabase Cloud Persistence with Single-Roundtrip Hydration & Batched Sync
 * - Complete Admin CRUD (Students, Teachers, Classes, Sections, Subjects, Exams, Marks, School & App Settings)
 * - Restricted Teacher Portal (Assigned Classes/Sections/Subjects, Validated Batch & Single Marks Entry, Results)
 * - Restricted Student Portal (Official Print-Ready Marksheet, Exam Result History, Profile & Password Management)
 */

import {
  isCloudConnected,
  cloudSetupNeeded,
  SUPABASE_SETUP_SQL,
  OperationType,
  initializeEduCoreCloud,
  hashPasswordSha256,
  fetchAllCloudRecords,
  upsertCloudRecord,
  upsertCloudBatch,
  deleteCloudRecord
} from './supabase.js';

// ============================================================================
// 1. GENERATED VISUAL ASSETS & DEFAULT CONSTANTS
// ============================================================================
const ASSETS = {
  heroCampus: './src/assets/images/hero_campus_architecture_1794813419213.jpg',
  heroCampusVideo: './assets/aistudio/download_178f5d9a.mp4',
  loginIllustration: './assets/aistudio/golden_hour_campus.webp',
  campusLogo: './assets/aistudio/Untitled_Design__1__fe1c933d.png',
  adminAvatar: './src/assets/images/avatar_principal_admin_1794813420311.jpg'
};

function normalizeAssetPath(url, fallbackUrl) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return fallbackUrl;
  if (raw === '/src/assets/images/avatar_principal_admin_1794813420311.jpg' || raw === './src/assets/images/avatar_principal_admin_1794813420311.jpg') {
    return fallbackUrl;
  }
  if (raw.startsWith('/assets/aistudio/') || raw.startsWith('/src/assets/images/')) {
    return `.${raw}`;
  }
  return raw;
}

function isForeignBlobUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw.toLowerCase().startsWith('blob:')) return false;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return !raw.startsWith(`blob:${window.location.origin}`);
  }
  return true;
}

function getSafeLogoSrc(url, fallbackUrl = ASSETS.campusLogo) {
  const normalized = normalizeAssetPath(url, fallbackUrl);
  if (!normalized || isForeignBlobUrl(normalized)) return fallbackUrl;
  return normalized;
}

const STORAGE_KEY = 'EDUCORE_DHBC_STATE_V1';
const SESSION_KEY = 'EDUCORE_DHBC_SESSION_V1';

const DEFAULT_GRADING_SCALE = [
  { grade: 'A+', minPercentage: 90, maxPercentage: 100, label: 'Outstanding', gpa: 4.0 },
  { grade: 'A', minPercentage: 80, maxPercentage: 89.99, label: 'Excellent', gpa: 3.7 },
  { grade: 'B+', minPercentage: 70, maxPercentage: 79.99, label: 'Very Good', gpa: 3.3 },
  { grade: 'B', minPercentage: 60, maxPercentage: 69.99, label: 'Good', gpa: 3.0 },
  { grade: 'C', minPercentage: 50, maxPercentage: 59.99, label: 'Satisfactory', gpa: 2.0 },
  { grade: 'D', minPercentage: 40, maxPercentage: 49.99, label: 'Pass', gpa: 1.0 },
  { grade: 'F', minPercentage: 0, maxPercentage: 39.99, label: 'Fail', gpa: 0.0 }
];

// ============================================================================
// 2. PURE ACADEMIC VALIDATION & GRADE CALCULATION ENGINE
// ============================================================================
export function validateMarkBounds(obtainedMarks, maxMarks, passMarks) {
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

export function calculateSubjectResult({ obtainedMarks, maxMarks, passMarks, gradingScale }) {
  const check = validateMarkBounds(obtainedMarks, maxMarks, passMarks);
  if (!check.valid) {
    throw new Error(check.error);
  }
  const scale = Array.isArray(gradingScale) && gradingScale.length > 0 ? gradingScale : DEFAULT_GRADING_SCALE;
  const percentage = Math.round(((obtainedMarks / maxMarks) * 100) * 100) / 100;
  const passed = obtainedMarks >= passMarks;

  if (!passed) {
    return {
      obtainedMarks,
      maxMarks,
      passMarks,
      percentage,
      grade: 'F',
      gradeLabel: 'Fail',
      gpa: 0.0,
      passed: false
    };
  }

  const sorted = [...scale].sort((a, b) => b.minPercentage - a.minPercentage);
  const matched = sorted.find((t) => percentage >= t.minPercentage) || sorted[sorted.length - 1];

  return {
    obtainedMarks,
    maxMarks,
    passMarks,
    percentage,
    grade: matched.grade,
    gradeLabel: matched.label,
    gpa: matched.gpa,
    passed: true
  };
}

export function calculateAggregateMarksheet(subjectMarks, gradingScale = DEFAULT_GRADING_SCALE) {
  if (!subjectMarks || !subjectMarks.length) {
    return {
      totalMaxMarks: 0,
      totalPassMarks: 0,
      totalObtainedMarks: 0,
      percentage: 0,
      grade: 'N/A',
      gradeLabel: 'No Marks Entered',
      gpa: 0.0,
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
    const res = calculateSubjectResult({
      obtainedMarks: Number(item.obtainedMarks),
      maxMarks: Number(item.maxMarks),
      passMarks: Number(item.passMarks),
      gradingScale
    });
    totalMaxMarks += res.maxMarks;
    totalPassMarks += res.passMarks;
    totalObtainedMarks += res.obtainedMarks;
    if (!res.passed) failedSubjectsCount += 1;
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

  const sorted = [...gradingScale].sort((a, b) => b.minPercentage - a.minPercentage);
  const matched = sorted.find((t) => percentage >= t.minPercentage) || sorted[sorted.length - 1];

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

export function validateStudentUniqueness(candidate, existingStudents) {
  const normAdm = String(candidate.admissionNo || '').trim().toUpperCase();
  const normRoll = String(candidate.rollNo || '').trim().toUpperCase();

  if (!normAdm) return { valid: false, error: 'Admission Number is required.' };
  if (!normRoll) return { valid: false, error: 'Roll Number is required.' };

  for (const stu of existingStudents) {
    if (candidate.id && stu.id === candidate.id) continue;
    if (String(stu.admissionNo || '').trim().toUpperCase() === normAdm) {
      return {
        valid: false,
        error: `Admission Number "${candidate.admissionNo}" is already assigned to ${stu.fullName}.`
      };
    }
    if (
      stu.classId === candidate.classId &&
      stu.sectionId === candidate.sectionId &&
      String(stu.rollNo || '').trim().toUpperCase() === normRoll
    ) {
      return {
        valid: false,
        error: `Roll Number "${candidate.rollNo}" is already assigned to ${stu.fullName} in this Class and Section.`
      };
    }
  }
  return { valid: true };
}

// ============================================================================
// 3. INITIAL SEED DATA FOR DARUL HUDA BENGAL CAMPUS
// ============================================================================
async function buildInitialCampusSeed() {
  const nowIso = new Date().toISOString();
  const adminHash = await hashPasswordSha256('Shakib000798', 'admin00798');
  const teacher1Hash = await hashPasswordSha256('Teacher@123', 'ustadh_farhan');
  const teacher2Hash = await hashPasswordSha256('Teacher@123', 'dr_amina');
  const student1Hash = await hashPasswordSha256('Student@123', 'ahmad_r');
  const student2Hash = await hashPasswordSha256('Student@123', 'zayd_k');
  const student3Hash = await hashPasswordSha256('Student@123', 'fatima_n');

  return {
    schoolSettings: {
      name: 'Darul Huda Bengal Campus',
      campusSubtitle: 'Centre for Higher Secondary & Integrated Islamic Studies, West Bengal',
      logoUrl: ASSETS.campusLogo,
      address: 'NH-12 Academic Enclave, Birbhum District, West Bengal 731224',
      phone: '+91 3462 258 900',
      email: 'registrar@darulhudabengal.edu.in',
      academicYear: '2026–2027',
      principalName: 'Dr. Syed Mahmudul Hasan',
      motto: 'Excellence in Sacred Scholarship & Modern Sciences',
      updatedAt: nowIso
    },
    appSettings: {
      appName: 'EDU CORE',
      logoText: 'DH',
      themeMode: 'dark',
      accentColor: '#FF642D',
      passPercentage: 40,
      gradingScaleJson: DEFAULT_GRADING_SCALE,
      updatedAt: nowIso
    },
    users: [
      {
        uid: 'usr_admin_dhbc',
        username: 'admin00798',
        role: 'admin',
        fullName: 'Dr. Syed Mahmudul Hasan',
        avatarUrl: ASSETS.adminAvatar,
        mustChangePassword: false,
        linkedEntityId: 'adm_root',
        passwordHash: adminHash,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        uid: 'usr_tch_farhan',
        username: 'ustadh_farhan',
        role: 'teacher',
        fullName: 'Ustadh Farhan Siddiqui',
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: 'tch_101',
        passwordHash: teacher1Hash,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        uid: 'usr_tch_amina',
        username: 'dr_amina',
        role: 'teacher',
        fullName: 'Dr. Amina Rahman',
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: 'tch_102',
        passwordHash: teacher2Hash,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        uid: 'usr_stu_ahmad',
        username: 'ahmad_r',
        role: 'student',
        fullName: 'Ahmad Raza Chowdhury',
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: 'stu_201',
        passwordHash: student1Hash,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        uid: 'usr_stu_zayd',
        username: 'zayd_k',
        role: 'student',
        fullName: 'Zayd Bin Karim',
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: 'stu_202',
        passwordHash: student2Hash,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        uid: 'usr_stu_fatima',
        username: 'fatima_n',
        role: 'student',
        fullName: 'Fatima Noor Siddiqua',
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: 'stu_203',
        passwordHash: student3Hash,
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    privateProfiles: {
      usr_admin_dhbc: {
        uid: 'usr_admin_dhbc',
        phone: '+91 98301 11200',
        address: 'Dean Residence, Darul Huda Bengal Campus, Birbhum',
        guardianName: 'Self',
        dateOfBirth: '1974-04-12',
        bloodGroup: 'O+',
        bio: 'Chief Academic Administrator & Principal Dean at Darul Huda Bengal Campus.',
        updatedAt: nowIso
      },
      usr_tch_farhan: {
        uid: 'usr_tch_farhan',
        phone: '+91 98304 44510',
        address: 'Faculty Quarters Block A-4, Rampurhat, West Bengal',
        guardianName: 'Maulana Abdul Qadir',
        dateOfBirth: '1988-09-19',
        bloodGroup: 'A+',
        bio: 'Senior Lecturer in Mathematics, Physics & Analytical Logic.',
        updatedAt: nowIso
      },
      usr_tch_amina: {
        uid: 'usr_tch_amina',
        phone: '+91 98308 77820',
        address: 'Faculty Quarters Block B-2, Santiniketan Road, West Bengal',
        guardianName: 'Prof. Habibur Rahman',
        dateOfBirth: '1990-02-05',
        bloodGroup: 'B+',
        bio: 'Associate Professor of Arabic Literature, Jurisprudence & English Rhetoric.',
        updatedAt: nowIso
      },
      usr_stu_ahmad: {
        uid: 'usr_stu_ahmad',
        phone: '+91 94341 55201',
        address: '42 Park Circus Avenue, Kolkata, West Bengal 700017',
        guardianName: 'Tariq Chowdhury',
        dateOfBirth: '2009-06-14',
        bloodGroup: 'B+',
        bio: 'Senior Secondary Scholar — Science & Classical Studies Track.',
        updatedAt: nowIso
      },
      usr_stu_zayd: {
        uid: 'usr_stu_zayd',
        phone: '+91 94341 55209',
        address: '18 Station Road, Murshidabad, West Bengal 742101',
        guardianName: 'Anwarul Karim',
        dateOfBirth: '2009-11-03',
        bloodGroup: 'O+',
        bio: 'Senior Secondary Scholar — Mathematics Olympiad Representative.',
        updatedAt: nowIso
      },
      usr_stu_fatima: {
        uid: 'usr_stu_fatima',
        phone: '+91 94341 55288',
        address: '7 Civil Lines, Burdwan, West Bengal 713101',
        guardianName: 'Dr. Naeem Siddiqui',
        dateOfBirth: '2010-01-22',
        bloodGroup: 'A+',
        bio: 'Secondary Honors Scholar.',
        updatedAt: nowIso
      }
    },
    classes: [
      {
        id: 'cls_sanawiyya_10',
        name: 'Sanawiyya Year II (Class X)',
        code: 'SNW-10',
        academicYear: '2026–2027',
        capacity: 60,
        description: 'Secondary Board & Classical Foundation Examination Cohort',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'cls_aliyya_12',
        name: 'Aliyya Senior (Class XII)',
        code: 'ALY-12',
        academicYear: '2026–2027',
        capacity: 50,
        description: 'Higher Secondary Integrated Science & Humanities Cohort',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    sections: [
      {
        id: 'sec_10_a',
        name: 'Section Al-Biruni (A)',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        roomNo: 'Hall 201',
        capacity: 30,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'sec_10_b',
        name: 'Section Ibn Sina (B)',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        roomNo: 'Hall 202',
        capacity: 30,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'sec_12_a',
        name: 'Section Al-Khwarizmi (A)',
        classId: 'cls_aliyya_12',
        className: 'Aliyya Senior (Class XII)',
        roomNo: 'Academic Block 305',
        capacity: 50,
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    subjects: [
      {
        id: 'sub_math_10',
        name: 'Advanced Mathematics',
        code: 'MTH-101',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        teacherId: 'tch_101',
        teacherName: 'Ustadh Farhan Siddiqui',
        maxMarks: 100,
        passMarks: 40,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'sub_phys_10',
        name: 'Physical Sciences',
        code: 'PHY-102',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        teacherId: 'tch_101',
        teacherName: 'Ustadh Farhan Siddiqui',
        maxMarks: 100,
        passMarks: 40,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'sub_arab_10',
        name: 'Classical Arabic & Literature',
        code: 'ARB-103',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        teacherId: 'tch_102',
        teacherName: 'Dr. Amina Rahman',
        maxMarks: 100,
        passMarks: 40,
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'sub_eng_12',
        name: 'English Rhetoric & Composition',
        code: 'ENG-201',
        classId: 'cls_aliyya_12',
        className: 'Aliyya Senior (Class XII)',
        teacherId: 'tch_102',
        teacherName: 'Dr. Amina Rahman',
        maxMarks: 100,
        passMarks: 40,
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    teachers: [
      {
        id: 'tch_101',
        userId: 'usr_tch_farhan',
        employeeId: 'DHBC-FAC-101',
        fullName: 'Ustadh Farhan Siddiqui',
        username: 'ustadh_farhan',
        designation: 'Senior Faculty — Mathematics & Physics',
        assignedClassIds: ['cls_sanawiyya_10'],
        assignedSectionIds: ['sec_10_a', 'sec_10_b'],
        assignedSubjectIds: ['sub_math_10', 'sub_phys_10'],
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'tch_102',
        userId: 'usr_tch_amina',
        employeeId: 'DHBC-FAC-102',
        fullName: 'Dr. Amina Rahman',
        username: 'dr_amina',
        designation: 'Associate Professor — Arabic & Humanities',
        assignedClassIds: ['cls_sanawiyya_10', 'cls_aliyya_12'],
        assignedSectionIds: ['sec_10_a', 'sec_12_a'],
        assignedSubjectIds: ['sub_arab_10', 'sub_eng_12'],
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    students: [
      {
        id: 'stu_201',
        userId: 'usr_stu_ahmad',
        admissionNo: 'DHBC-2026-001',
        rollNo: '01',
        fullName: 'Ahmad Raza Chowdhury',
        username: 'ahmad_r',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'stu_202',
        userId: 'usr_stu_zayd',
        admissionNo: 'DHBC-2026-002',
        rollNo: '02',
        fullName: 'Zayd Bin Karim',
        username: 'zayd_k',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'stu_203',
        userId: 'usr_stu_fatima',
        admissionNo: 'DHBC-2026-003',
        rollNo: '01',
        fullName: 'Fatima Noor Siddiqua',
        username: 'fatima_n',
        classId: 'cls_aliyya_12',
        className: 'Aliyya Senior (Class XII)',
        sectionId: 'sec_12_a',
        sectionName: 'Section Al-Khwarizmi (A)',
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    examinations: [
      {
        id: 'exm_midterm_2026',
        name: 'First Semester Collegiate Examination 2026',
        academicYear: '2026–2027',
        term: 'Semester I',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        maxMarks: 100,
        passMarks: 40,
        status: 'published',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'exm_aliyya_2026',
        name: 'Senior Aliyya Mid-Term Assessment 2026',
        academicYear: '2026–2027',
        term: 'Semester I',
        classId: 'cls_aliyya_12',
        className: 'Aliyya Senior (Class XII)',
        sectionId: 'sec_12_a',
        sectionName: 'Section Al-Khwarizmi (A)',
        maxMarks: 100,
        passMarks: 40,
        status: 'published',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    marks: [
      {
        id: 'mrk_201_math',
        examId: 'exm_midterm_2026',
        examName: 'First Semester Collegiate Examination 2026',
        studentId: 'stu_201',
        studentUserId: 'usr_stu_ahmad',
        studentName: 'Ahmad Raza Chowdhury',
        admissionNo: 'DHBC-2026-001',
        rollNo: '01',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        subjectId: 'sub_math_10',
        subjectName: 'Advanced Mathematics',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 94,
        percentage: 94,
        grade: 'A+',
        passed: true,
        teacherId: 'tch_101',
        teacherUserId: 'usr_tch_farhan',
        remarks: 'Exceptional analytical rigor',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'mrk_201_phys',
        examId: 'exm_midterm_2026',
        examName: 'First Semester Collegiate Examination 2026',
        studentId: 'stu_201',
        studentUserId: 'usr_stu_ahmad',
        studentName: 'Ahmad Raza Chowdhury',
        admissionNo: 'DHBC-2026-001',
        rollNo: '01',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        subjectId: 'sub_phys_10',
        subjectName: 'Physical Sciences',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 88,
        percentage: 88,
        grade: 'A',
        passed: true,
        teacherId: 'tch_101',
        teacherUserId: 'usr_tch_farhan',
        remarks: 'Strong laboratory work',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'mrk_201_arab',
        examId: 'exm_midterm_2026',
        examName: 'First Semester Collegiate Examination 2026',
        studentId: 'stu_201',
        studentUserId: 'usr_stu_ahmad',
        studentName: 'Ahmad Raza Chowdhury',
        admissionNo: 'DHBC-2026-001',
        rollNo: '01',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        subjectId: 'sub_arab_10',
        subjectName: 'Classical Arabic & Literature',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 91,
        percentage: 91,
        grade: 'A+',
        passed: true,
        teacherId: 'tch_102',
        teacherUserId: 'usr_tch_amina',
        remarks: 'Distinction in rhetoric',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'mrk_202_math',
        examId: 'exm_midterm_2026',
        examName: 'First Semester Collegiate Examination 2026',
        studentId: 'stu_202',
        studentUserId: 'usr_stu_zayd',
        studentName: 'Zayd Bin Karim',
        admissionNo: 'DHBC-2026-002',
        rollNo: '02',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        subjectId: 'sub_math_10',
        subjectName: 'Advanced Mathematics',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 82,
        percentage: 82,
        grade: 'A',
        passed: true,
        teacherId: 'tch_101',
        teacherUserId: 'usr_tch_farhan',
        remarks: 'Commendable problem solving',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'mrk_202_phys',
        examId: 'exm_midterm_2026',
        examName: 'First Semester Collegiate Examination 2026',
        studentId: 'stu_202',
        studentUserId: 'usr_stu_zayd',
        studentName: 'Zayd Bin Karim',
        admissionNo: 'DHBC-2026-002',
        rollNo: '02',
        classId: 'cls_sanawiyya_10',
        className: 'Sanawiyya Year II (Class X)',
        sectionId: 'sec_10_a',
        sectionName: 'Section Al-Biruni (A)',
        subjectId: 'sub_phys_10',
        subjectName: 'Physical Sciences',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 76,
        percentage: 76,
        grade: 'B+',
        passed: true,
        teacherId: 'tch_101',
        teacherUserId: 'usr_tch_farhan',
        remarks: 'Consistent progress',
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'mrk_203_eng',
        examId: 'exm_aliyya_2026',
        examName: 'Senior Aliyya Mid-Term Assessment 2026',
        studentId: 'stu_203',
        studentUserId: 'usr_stu_fatima',
        studentName: 'Fatima Noor Siddiqua',
        admissionNo: 'DHBC-2026-003',
        rollNo: '01',
        classId: 'cls_aliyya_12',
        className: 'Aliyya Senior (Class XII)',
        sectionId: 'sec_12_a',
        sectionName: 'Section Al-Khwarizmi (A)',
        subjectId: 'sub_eng_12',
        subjectName: 'English Rhetoric & Composition',
        maxMarks: 100,
        passMarks: 40,
        obtainedMarks: 95,
        percentage: 95,
        grade: 'A+',
        passed: true,
        teacherId: 'tch_102',
        teacherUserId: 'usr_tch_amina',
        remarks: 'First rank in composition',
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    activityLogs: [
      {
        id: 'log_init_1',
        actorUid: 'usr_admin_dhbc',
        actorName: 'Dr. Syed Mahmudul Hasan',
        actorRole: 'admin',
        action: 'Published First Semester Collegiate Examination 2026 schedule',
        category: 'Examination',
        createdAt: nowIso
      },
      {
        id: 'log_init_2',
        actorUid: 'usr_tch_farhan',
        actorName: 'Ustadh Farhan Siddiqui',
        actorRole: 'teacher',
        action: 'Entered Advanced Mathematics marks for Sanawiyya Year II (Class X)',
        category: 'Marks',
        createdAt: nowIso
      }
    ]
  };
}

// ============================================================================
// 4. APPLICATION STATE & CLOUD/LOCAL PERSISTENCE MANAGER
// ============================================================================
const state = {
  ready: false,
  screen: 'landing', // 'landing' | 'login' | 'dashboard'
  loginRoleTab: 'admin', // 'admin' | 'teacher' | 'student'
  showPassword: false,
  loginError: '',
  currentUser: null,
  sidebarOpen: false,
  activeNav: 'overview',
  // Firebase Cloud Auth & Sync Status
  cloudAuthStatus: 'idle', // 'idle' | 'connected' | 'provider_disabled' | 'error'
  adminMarkerVerified: false,
  cloudSyncBusy: false,
  sessionPlainPassword: '',
  // Filters & Pagination
  studentSearch: '',
  studentClassFilter: 'all',
  studentSectionFilter: 'all',
  studentPage: 1,
  marksExamFilter: 'all',
  marksClassFilter: 'all',
  marksSectionFilter: 'all',
  marksSubjectFilter: 'all',
  marksSearch: '',
  marksPage: 1,
  // Teacher Marks Entry Selection
  entryClassId: '',
  entrySectionId: '',
  entrySubjectId: '',
  entryExamId: '',
  // Student Marksheet Selection
  selectedStudentExamId: '',
  // Public Marksheet Lookup
  publicVerifyAdmissionNo: '',
  publicVerifyResult: null,
  // Data Store
  data: null
};

function normalizeUsername(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

const FIRESTORE_ALLOWED_FIELDS = {
  admins: ['uid', 'username', 'createdAt'],
  users: ['uid', 'username', 'role', 'fullName', 'avatarUrl', 'mustChangePassword', 'linkedEntityId', 'passwordHash', 'createdAt', 'updatedAt'],
  userPrivate: ['uid', 'phone', 'address', 'guardianName', 'dateOfBirth', 'bloodGroup', 'bio', 'updatedAt'],
  students: ['id', 'userId', 'admissionNo', 'rollNo', 'fullName', 'username', 'classId', 'className', 'sectionId', 'sectionName', 'avatarUrl', 'status', 'createdAt', 'updatedAt'],
  teachers: ['id', 'userId', 'employeeId', 'fullName', 'username', 'designation', 'assignedClassIds', 'assignedSectionIds', 'assignedSubjectIds', 'avatarUrl', 'status', 'createdAt', 'updatedAt'],
  classes: ['id', 'name', 'code', 'academicYear', 'capacity', 'description', 'createdAt', 'updatedAt'],
  sections: ['id', 'name', 'classId', 'className', 'roomNo', 'capacity', 'createdAt', 'updatedAt'],
  subjects: ['id', 'name', 'code', 'classId', 'className', 'teacherId', 'teacherName', 'maxMarks', 'passMarks', 'createdAt', 'updatedAt'],
  examinations: ['id', 'name', 'academicYear', 'term', 'classId', 'className', 'sectionId', 'sectionName', 'maxMarks', 'passMarks', 'status', 'createdAt', 'updatedAt'],
  marks: ['id', 'examId', 'examName', 'studentId', 'studentUserId', 'studentName', 'admissionNo', 'rollNo', 'classId', 'className', 'sectionId', 'sectionName', 'subjectId', 'subjectName', 'maxMarks', 'passMarks', 'obtainedMarks', 'percentage', 'grade', 'passed', 'teacherId', 'teacherUserId', 'remarks', 'createdAt', 'updatedAt'],
  schoolSettings: ['name', 'campusSubtitle', 'logoUrl', 'address', 'phone', 'email', 'academicYear', 'principalName', 'motto', 'updatedAt'],
  appSettings: ['appName', 'logoText', 'themeMode', 'accentColor', 'passPercentage', 'gradingScaleJson', 'updatedAt'],
  activityLogs: ['id', 'actorUid', 'actorName', 'actorRole', 'action', 'category', 'createdAt'],
  campusIndex: ['userIds', 'studentIds', 'teacherIds', 'classIds', 'sectionIds', 'subjectIds', 'examIds', 'markIds', 'activityLogIds', 'updatedAt']
};

function sanitizeFirestorePayload(collectionKey, payload) {
  const allowed = FIRESTORE_ALLOWED_FIELDS[collectionKey];
  if (!allowed) return { ...payload };
  const out = {};
  for (const key of allowed) {
    if (key in payload && payload[key] !== undefined) {
      out[key] = payload[key];
    }
  }
  return out;
}

function saveLocalStore() {
  if (!state.data) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  } catch (e) {
    console.warn('Unable to cache state in localStorage:', e);
  }
}

async function withTimeout(promise, ms = 6000, fallbackValue = null) {
  let timerId;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timerId = setTimeout(() => resolve(fallbackValue), ms);
      })
    ]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function syncDocumentToFirestore(collectionName, docId, payload, _opType = OperationType.WRITE, options = {}) {
  saveLocalStore();
  if (!isCloudConnected || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { localSaved: true, cloudSaved: false, reason: 'cloud_disconnected' };
  }
  const schemaKey = collectionName.endsWith('/private') ? 'userPrivate' : collectionName;
  const timeoutMs = Number(options.timeoutMs) || 6500;
  const cleanPayload = sanitizeFirestorePayload(schemaKey, payload);
  const nowIso = new Date().toISOString();
  const allowedFields = FIRESTORE_ALLOWED_FIELDS[schemaKey] || [];
  if (allowedFields.includes('createdAt') && !cleanPayload.createdAt) {
    cleanPayload.createdAt = nowIso;
  }
  if (allowedFields.includes('updatedAt') && !cleanPayload.updatedAt) {
    cleanPayload.updatedAt = nowIso;
  }

  const res = await withTimeout(
    upsertCloudRecord(collectionName, docId, cleanPayload),
    timeoutMs,
    { ok: false, reason: 'cloud_timeout' }
  );

  if (res && res.ok) {
    state.cloudAuthStatus = 'connected';
    return { localSaved: true, cloudSaved: true };
  }
  if (res?.reason === 'table_missing') {
    state.cloudAuthStatus = 'setup_needed';
  }
  return { localSaved: true, cloudSaved: false, reason: res?.reason || 'cloud_error' };
}

async function deleteDocumentFromFirestore(collectionName, docId) {
  saveLocalStore();
  if (!isCloudConnected || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { localSaved: true, cloudSaved: false, reason: 'cloud_disconnected' };
  }
  const res = await withTimeout(deleteCloudRecord(collectionName, docId), 6500, { ok: false, reason: 'cloud_timeout' });
  if (res && res.ok) {
    state.cloudAuthStatus = 'connected';
    return { localSaved: true, cloudSaved: true };
  }
  if (res?.reason === 'table_missing') {
    state.cloudAuthStatus = 'setup_needed';
  }
  return { localSaved: true, cloudSaved: false, reason: res?.reason || 'cloud_error' };
}

async function pushAllLocalDataToFirestore() {
  if (!isCloudConnected || !state.data) {
    return false;
  }
  const d = state.data;
  const nowIso = new Date().toISOString();
  const batchRows = [];

  const pushRow = (collectionName, docId, rawPayload) => {
    const schemaKey = collectionName.endsWith('/private') ? 'userPrivate' : collectionName;
    const clean = sanitizeFirestorePayload(schemaKey, rawPayload);
    const allowed = FIRESTORE_ALLOWED_FIELDS[schemaKey] || [];
    if (allowed.includes('createdAt') && !clean.createdAt) clean.createdAt = nowIso;
    if (allowed.includes('updatedAt') && !clean.updatedAt) clean.updatedAt = nowIso;
    batchRows.push({ collection: collectionName, doc_id: String(docId), data: clean });
  };

  for (const cls of d.classes || []) pushRow('classes', cls.id, cls);
  for (const sec of d.sections || []) pushRow('sections', sec.id, sec);
  for (const sub of d.subjects || []) pushRow('subjects', sub.id, sub);
  for (const usr of d.users || []) {
    pushRow('users', usr.uid, usr);
    const priv = d.privateProfiles?.[usr.uid];
    if (priv) pushRow(`users/${usr.uid}/private`, 'info', priv);
  }
  for (const tch of d.teachers || []) pushRow('teachers', tch.id, tch);
  for (const stu of d.students || []) pushRow('students', stu.id, stu);
  for (const ex of d.examinations || []) pushRow('examinations', ex.id, ex);
  for (const mrk of d.marks || []) pushRow('marks', mrk.id, mrk);
  for (const logItem of (d.activityLogs || []).slice(0, 50)) pushRow('activityLogs', logItem.id, logItem);
  if (d.schoolSettings) pushRow('schoolSettings', 'main', d.schoolSettings);
  if (d.appSettings) pushRow('appSettings', 'main', d.appSettings);

  const res = await upsertCloudBatch(batchRows);
  if (res && res.ok) {
    state.cloudAuthStatus = 'connected';
    localStorage.setItem('EDUCORE_CLOUD_RECONCILED_V2', 'true');
    return true;
  }
  if (res?.reason === 'table_missing') {
    state.cloudAuthStatus = 'setup_needed';
  }
  return false;
}

async function hydrateFromFirestoreForSession(_userRecord = null, options = {}) {
  if (!isCloudConnected || !state.data) return false;
  try {
    const res = await fetchAllCloudRecords(options);
    if (!res.ok) {
      if (res.reason === 'table_missing') {
        state.cloudAuthStatus = 'setup_needed';
      } else {
        state.cloudAuthStatus = 'error';
      }
      return false;
    }

    const rows = res.rows || [];
    if (rows.length === 0) {
      return await pushAllLocalDataToFirestore();
    }

    const grouped = {
      users: [],
      students: [],
      teachers: [],
      classes: [],
      sections: [],
      subjects: [],
      examinations: [],
      marks: [],
      activityLogs: [],
      schoolSettings: null,
      appSettings: null,
      privateProfiles: {}
    };

    for (const row of rows) {
      const col = String(row.collection || '');
      const docId = String(row.doc_id || '');
      const payload = row.data && typeof row.data === 'object' ? { ...row.data } : null;
      if (!payload) continue;

      if (col === 'schoolSettings' && docId === 'main') {
        grouped.schoolSettings = payload;
      } else if (col === 'appSettings' && docId === 'main') {
        grouped.appSettings = payload;
      } else if (col.startsWith('users/') && col.endsWith('/private')) {
        const uid = col.slice('users/'.length, -'/private'.length);
        if (uid) grouped.privateProfiles[uid] = payload;
      } else if (Array.isArray(grouped[col])) {
        grouped[col].push(payload);
      }
    }

    const reconciledFlag = localStorage.getItem('EDUCORE_CLOUD_RECONCILED_V2') === 'true';
    const cloudStudentIdSet = new Set(grouped.students.map((s) => s.id));
    const DEFAULT_SEED_IDS = new Set([
      'stu_201', 'stu_202', 'stu_203',
      'tch_101', 'tch_102',
      'cls_sanawiyya_10', 'cls_aliyya_12',
      'sec_10_a', 'sec_10_b', 'sec_12_a',
      'sub_math_10', 'sub_phys_10', 'sub_arab_10', 'sub_eng_12',
      'exm_midterm_2026', 'exm_aliyya_2026'
    ]);
    const localHasUnsyncedCustomData =
      !reconciledFlag &&
      grouped.users.length === 0 && (
        (state.data.students || []).some((s) => !DEFAULT_SEED_IDS.has(s.id) && !cloudStudentIdSet.has(s.id)) ||
        (state.data.teachers || []).some((t) => !DEFAULT_SEED_IDS.has(t.id)) ||
        (state.data.classes || []).some((c) => !DEFAULT_SEED_IDS.has(c.id)) ||
        (state.data.sections || []).some((s) => !DEFAULT_SEED_IDS.has(s.id)) ||
        (state.data.subjects || []).some((s) => !DEFAULT_SEED_IDS.has(s.id)) ||
        (state.data.examinations || []).some((e) => !DEFAULT_SEED_IDS.has(e.id))
      );

    if (localHasUnsyncedCustomData) {
      return await pushAllLocalDataToFirestore();
    }

    if (grouped.schoolSettings) {
      state.data.schoolSettings = { ...state.data.schoolSettings, ...grouped.schoolSettings };
    }
    if (grouped.appSettings) {
      state.data.appSettings = { ...state.data.appSettings, ...grouped.appSettings };
    }
    if (grouped.users.length > 0) {
      state.data.users = grouped.users;
    }
    state.data.students = grouped.students;
    state.data.teachers = grouped.teachers;
    state.data.classes = grouped.classes;
    state.data.sections = grouped.sections;
    state.data.subjects = grouped.subjects;
    state.data.examinations = grouped.examinations;
    state.data.marks = grouped.marks;
    state.data.activityLogs = grouped.activityLogs.sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
    state.data.privateProfiles = {
      ...(state.data.privateProfiles || {}),
      ...grouped.privateProfiles
    };

    state.cloudAuthStatus = 'connected';
    localStorage.setItem('EDUCORE_CLOUD_RECONCILED_V2', 'true');
    saveLocalStore();
    return true;
  } catch (err) {
    console.warn('Supabase hydration warning:', err);
    return false;
  }
}

async function ensureFirebaseSessionForUser(userRecord, _rawPassword) {
  if (!isCloudConnected || !userRecord) {
    state.cloudAuthStatus = 'idle';
    return { connected: false, reason: 'no_cloud_config' };
  }
  const ok = await hydrateFromFirestoreForSession(userRecord);
  if (ok) {
    state.cloudAuthStatus = 'connected';
    return { connected: true, uid: userRecord.uid };
  }
  return {
    connected: false,
    reason: cloudSetupNeeded ? 'table_missing' : 'cloud_unreachable'
  };
}

async function recordActivity(action, category = 'System') {
  if (!state.currentUser || !state.data) return;
  const actorUid = state.currentUser.uid;
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    actorUid,
    actorName: state.currentUser.fullName,
    actorRole: state.currentUser.role,
    action: String(action).slice(0, 235),
    category: String(category).slice(0, 38),
    createdAt: new Date().toISOString()
  };
  state.data.activityLogs.unshift(entry);
  await syncDocumentToFirestore('activityLogs', entry.id, entry, OperationType.CREATE);
}

// ============================================================================
// 5. THEME & APPEARANCE ENGINE
// ============================================================================
function applyThemeSettings() {
  if (!state.data?.appSettings) return;
  const { themeMode, accentColor, appName } = state.data.appSettings;
  document.body.setAttribute('data-theme', themeMode === 'cream' ? 'cream' : 'dark');
  if (accentColor && /^#[0-9A-Fa-f]{6}$/.test(accentColor)) {
    document.documentElement.style.setProperty('--accent', accentColor);
    document.documentElement.style.setProperty('--accent-hover', accentColor);
  }
  if (appName && state.data?.schoolSettings?.name) {
    document.title = `${appName} — ${state.data.schoolSettings.name}`;
  }
}

// ============================================================================
// 6. UI UTILITIES (ESCAPING, TOASTS, MODALS)
// ============================================================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const item = document.createElement('div');
  item.className = 'toast-item';
  const glyph = type === 'error' ? '■ ERROR' : type === 'success' ? '▲ SAVED' : '● INFO';
  const glyphColor =
    type === 'error' ? 'var(--status-fail)' : type === 'success' ? 'var(--status-pass)' : 'var(--accent)';
  item.innerHTML = `
    <div>
      <span class="mono-code" style="color:${glyphColor};font-weight:700;margin-right:0.5rem;">${glyph}</span>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  root.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3800);
}

function closeModal() {
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) modalRoot.innerHTML = '';
}

async function compressImageFileToDataUri(file, options = {}) {
  const maxDimension = options.maxDimension || 360;
  const maxChars = options.maxChars || 200000;
  const maxRawBytes = options.maxRawBytes || 10 * 1024 * 1024;

  if (!file || !file.type || !file.type.startsWith('image/')) {
    throw new Error('Please choose a valid image file (PNG, JPG, WebP, or SVG).');
  }
  if (file.size > maxRawBytes) {
    throw new Error('Image file is larger than 10 MB. Please choose a smaller image.');
  }

  const rawDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Unable to read image file.'));
    };
    reader.onerror = () => reject(new Error('Failed to read selected image file.'));
    reader.readAsDataURL(file);
  });

  if (file.type === 'image/svg+xml' && rawDataUrl.length <= maxChars) {
    return rawDataUrl;
  }

  const img = await new Promise((resolve, reject) => {
    const imageEl = new Image();
    imageEl.onload = () => resolve(imageEl);
    imageEl.onerror = () => reject(new Error('Selected file could not be decoded as an image.'));
    imageEl.src = rawDataUrl;
  });

  const dimensionSteps = [maxDimension, Math.round(maxDimension * 0.72), Math.round(maxDimension * 0.5), 128];
  const preserveAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/svg+xml' || file.type === 'image/gif';

  for (const dim of dimensionSteps) {
    const naturalW = img.naturalWidth || img.width || dim;
    const naturalH = img.naturalHeight || img.height || dim;
    const scale = Math.min(1, dim / Math.max(naturalW, naturalH));
    const targetW = Math.max(1, Math.round(naturalW * scale));
    const targetH = Math.max(1, Math.round(naturalH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    if (preserveAlpha) {
      const pngUri = canvas.toDataURL('image/png');
      if (pngUri.length <= maxChars) return pngUri;

      for (const q of [0.88, 0.76, 0.62, 0.48]) {
        const webpUri = canvas.toDataURL('image/webp', q);
        if (webpUri.startsWith('data:image/webp') && webpUri.length <= maxChars) {
          return webpUri;
        }
      }
    }

    for (const q of [0.88, 0.75, 0.6, 0.45]) {
      const jpegUri = canvas.toDataURL('image/jpeg', q);
      if (jpegUri.length <= maxChars) return jpegUri;
    }
  }

  if (rawDataUrl.length <= maxChars) {
    return rawDataUrl;
  }
  throw new Error('Could not compress image under Firestore size limit. Please use a simpler or smaller image.');
}

function openConfirmDeleteModal({ title, message, onConfirm }) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div class="modal-dialog" style="max-width:460px;">
        <div class="modal-header">
          <h2 id="confirm-modal-title">${escapeHtml(title)}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-cancel-top">Close</button>
        </div>
        <p style="color:var(--text-secondary);font-size:0.92rem;line-height:1.6;">
          ${escapeHtml(message)}
        </p>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
          <button type="button" class="btn btn-danger" id="modal-confirm-delete-btn">Confirm Delete</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modal-cancel-top')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-confirm-delete-btn')?.addEventListener('click', async () => {
    closeModal();
    await onConfirm();
  });
}

// Force Initial Admin Password Change Modal (Required by Section 4)
function openForcePasswordChangeModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot || !state.currentUser) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="force-pwd-title">
      <div class="modal-dialog" style="max-width:500px;">
        <div class="modal-header">
          <h2 id="force-pwd-title">Security Policy: Change Initial Admin Password</h2>
        </div>
        <p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:1.25rem;">
          You logged in with the initial bootstrap credentials (<span class="mono-code">admin</span>). For campus security compliance, you must set a new password before continuing.
        </p>
        <form id="force-pwd-form">
          <div class="form-field">
            <label for="new-admin-password">New Administrator Password (min 6 characters)</label>
            <input type="password" id="new-admin-password" class="form-input" required minlength="6" placeholder="Enter strong new password" />
          </div>
          <div class="form-field">
            <label for="confirm-admin-password">Confirm New Password</label>
            <input type="password" id="confirm-admin-password" class="form-input" required minlength="6" placeholder="Re-enter new password" />
          </div>
          <div id="force-pwd-error" style="color:var(--status-fail);font-size:0.84rem;margin-bottom:0.75rem;"></div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">Save New Password & Unlock Portal</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('force-pwd-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd1 = document.getElementById('new-admin-password').value;
    const pwd2 = document.getElementById('confirm-admin-password').value;
    const errEl = document.getElementById('force-pwd-error');

    if (pwd1.length < 6) {
      errEl.textContent = 'Password must be at least 6 characters.';
      return;
    }
    if (pwd1 === 'admin123') {
      errEl.textContent = 'New password cannot be the default initial password (admin123).';
      return;
    }
    if (pwd1 !== pwd2) {
      errEl.textContent = 'Passwords do not match.';
      return;
    }

    const newHash = await hashPasswordSha256(pwd1, state.currentUser.username);
    const userDoc = state.data.users.find((u) => u.uid === state.currentUser.uid);
    if (userDoc) {
      userDoc.passwordHash = newHash;
      userDoc.mustChangePassword = false;
      userDoc.updatedAt = new Date().toISOString();
      state.currentUser = { ...userDoc };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
      await syncDocumentToFirestore('users', userDoc.uid, userDoc, OperationType.UPDATE);
      await recordActivity('Completed mandatory initial Administrator password rotation', 'Security');
    }
    closeModal();
    showToast('Administrator password updated securely.', 'success');
    renderApp();
  });
}

function openForgotPasswordModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const school = state.data?.schoolSettings || {};
  const role = state.loginRoleTab || 'admin';
  const roleTitle = role === 'admin' ? 'Administrator Recovery' : role === 'teacher' ? 'Faculty Password Help' : 'Scholar Password Help';

  const bodyHtml =
    role === 'admin'
      ? `
        <p style="font-size:0.9rem;color:var(--text-secondary);line-height:1.55;">
          The primary administrator account is <span class="mono-code">@admin00798</span>.
          If you previously changed the password on this browser and can no longer recall it, you can clear the local browser cache below to restore the default local credentials (<span class="mono-code">@admin00798</span>) and re-sync from Supabase Cloud if available.
        </p>
        <div class="alert-notice" style="margin-top:0.75rem;">
          <strong>Note:</strong> Clearing local browser cache removes unsynced local-only changes stored in this browser.
        </div>
      `
      : `
        <p style="font-size:0.9rem;color:var(--text-secondary);line-height:1.55;">
          ${role === 'teacher' ? 'Teacher' : 'Student'} passwords are managed centrally by the Campus Administrator for security.
          Please contact your Administrator to set a new password in <strong>${role === 'teacher' ? 'Teacher Management' : 'Student Management'}</strong>.
        </p>
        <div class="alert-notice" style="margin-top:0.75rem;">
          ${school.email ? `<div><strong>Campus Email:</strong> ${escapeHtml(school.email)}</div>` : ''}
          ${school.phone ? `<div><strong>Office Phone:</strong> ${escapeHtml(school.phone)}</div>` : ''}
        </div>
      `;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="forgot-pwd-title">
      <div class="modal-dialog" style="max-width:480px;">
        <div class="modal-header">
          <div>
            <p class="editorial-kicker" style="margin-bottom:0.25rem;">ACCOUNT RECOVERY</p>
            <h3 id="forgot-pwd-title">${escapeHtml(roleTitle)}</h3>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="close-forgot-pwd-modal">Close</button>
        </div>
        <div class="modal-body">
          ${bodyHtml}
          <div class="modal-footer" style="margin-top:1.25rem;">
            ${
              role === 'admin'
                ? `<button type="button" class="btn btn-primary" id="btn-reset-local-admin-cache">Reset Local Cache &amp; Reload</button>`
                : ''
            }
            <button type="button" class="btn btn-secondary" id="btn-dismiss-forgot-pwd">Got It</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('close-forgot-pwd-modal')?.addEventListener('click', closeModal);
  document.getElementById('btn-dismiss-forgot-pwd')?.addEventListener('click', closeModal);
  document.getElementById('btn-reset-local-admin-cache')?.addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem('EDUCORE_CLOUD_RECONCILED_V2');
      sessionStorage.removeItem(SESSION_KEY);
    } catch (_e) {
      // Ignore storage clear errors
    }
    closeModal();
    window.location.reload();
  });
}

// ============================================================================
// 7. AUTHENTICATION FLOW (USERNAME + PASSWORD ONLY)
// ============================================================================
async function handleUsernameLogin(usernameInput, passwordInput, expectedRole) {
  const cleanUsername = normalizeUsername(usernameInput);
  const rawPassword = String(passwordInput || '');

  if (!cleanUsername) {
    state.loginError = 'Please enter your username.';
    renderApp();
    return;
  }
  if (!rawPassword) {
    state.loginError = 'Please enter your password.';
    renderApp();
    return;
  }

  let matchedUser = state.data.users.find(
    (u) => normalizeUsername(u.username) === cleanUsername && u.role === expectedRole
  );
  let candidateHash = matchedUser
    ? await hashPasswordSha256(rawPassword, matchedUser.username)
    : '';

  // If account or password changed recently on another device, do a fast cloud refresh first
  if ((!matchedUser || candidateHash !== matchedUser.passwordHash) && isCloudConnected && !cloudSetupNeeded) {
    const synced = await withTimeout(hydrateFromFirestoreForSession(null), 4000, false);
    if (synced) {
      matchedUser = state.data.users.find(
        (u) => normalizeUsername(u.username) === cleanUsername && u.role === expectedRole
      );
      candidateHash = matchedUser
        ? await hashPasswordSha256(rawPassword, matchedUser.username)
        : '';
    }
  }

  if (!matchedUser) {
    const existsInOtherRole = state.data.users.find((u) => normalizeUsername(u.username) === cleanUsername);
    if (existsInOtherRole) {
      state.loginError = `Account "${cleanUsername}" belongs to the ${existsInOtherRole.role.toUpperCase()} portal. Please switch the role tab above.`;
    } else {
      state.loginError = 'Invalid username or password for this portal.';
    }
    renderApp();
    return;
  }

  if (candidateHash !== matchedUser.passwordHash) {
    state.loginError = 'Invalid username or password. Please verify your credentials.';
    renderApp();
    return;
  }

  state.loginError = '';
  state.sessionPlainPassword = rawPassword;
  state.currentUser = { ...matchedUser };
  state.screen = 'dashboard';
  state.activeNav = 'overview';

  // Initialize default selections for Teacher or Student immediately
  if (matchedUser.role === 'teacher') {
    const teacher = state.data.teachers.find((t) => t.userId === matchedUser.uid);
    if (teacher) {
      state.entryClassId = teacher.assignedClassIds[0] || '';
      state.entrySectionId = teacher.assignedSectionIds[0] || '';
      state.entrySubjectId = teacher.assignedSubjectIds[0] || '';
      state.entryExamId = state.data.examinations[0]?.id || '';
    }
  } else if (matchedUser.role === 'student') {
    const student = state.data.students.find((s) => s.userId === matchedUser.uid);
    if (student) {
      const studentExams = state.data.examinations.filter((ex) => ex.classId === student.classId);
      state.selectedStudentExamId = studentExams[0]?.id || state.data.examinations[0]?.id || '';
    }
  }

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
  renderApp();

  if (matchedUser.role === 'admin' && matchedUser.mustChangePassword) {
    openForcePasswordChangeModal();
  } else {
    showToast(`Welcome back, ${matchedUser.fullName}`, 'success');
  }

  // Sync Firebase session & activity log asynchronously so dashboard opens instantaneously
  void (async () => {
    try {
      const fbRes = await withTimeout(
        ensureFirebaseSessionForUser(matchedUser, rawPassword),
        8000,
        { connected: false, reason: 'cloud_timeout' }
      );
      await recordActivity(`Signed in to ${matchedUser.role.toUpperCase()} portal`, 'Auth');
      if (fbRes?.connected && state.currentUser && state.screen === 'dashboard') {
        const freshMatched = state.data.users.find((u) => u.uid === matchedUser.uid) || matchedUser;
        state.currentUser = { ...freshMatched };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
        const modalRoot = document.getElementById('modal-root');
        const activeEl = document.activeElement;
        const isEditing = activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName);
        if ((!modalRoot || modalRoot.children.length === 0) && !isEditing) {
          renderApp();
        }
      }
    } catch (_err) {
      // Offline / local mode already active
    }
  })();
}

async function handleLogout() {
  state.currentUser = null;
  state.sessionPlainPassword = '';
  state.cloudAuthStatus = 'idle';
  state.screen = 'login';
  state.sidebarOpen = false;
  sessionStorage.removeItem(SESSION_KEY);
  closeModal();
  showToast('Signed out of EDU CORE safely.', 'info');
  renderApp();
}

// ============================================================================
// 8. PUBLIC LANDING VIEW & LOGIN VIEW RENDERERS
// ============================================================================
function renderPublicTopBar() {
  const school = state.data.schoolSettings;
  const appCfg = state.data.appSettings;
  const isLogged = Boolean(state.currentUser);

  return `
    <header class="public-topbar">
      <a href="#top" class="brand-wordmark" id="nav-brand-home">
        <img
          src="${escapeHtml(getSafeLogoSrc(school.logoUrl, ASSETS.campusLogo))}"
          alt=""
          class="brand-corner-logo"
          referrerpolicy="no-referrer"
          onerror="this.style.display='none'"
        />
        <span>${escapeHtml(appCfg.appName)}</span>
      </a>
      <nav class="public-nav-links" aria-label="Primary Navigation">
        <a href="#portals" class="public-nav-link">Role Portals</a>
        <a href="#verification" class="public-nav-link">Marksheet Verification</a>
        <a href="#grading-rubric" class="public-nav-link">Grading Scale</a>
        <a href="#campus-info" class="public-nav-link">Campus Directory</a>
      </nav>
      <div>
        ${
          isLogged
            ? `<button type="button" class="btn btn-primary" id="topbar-open-dashboard-btn">Open ${escapeHtml(state.currentUser.role.toUpperCase())} Dashboard</button>`
            : `<button type="button" class="btn btn-primary" id="topbar-login-btn">Portal Login</button>`
        }
      </div>
    </header>
  `;
}

function renderLandingScreen() {
  const school = state.data.schoolSettings;
  const appCfg = state.data.appSettings;
  const totalStudents = state.data.students.length;
  const totalTeachers = state.data.teachers.length;
  const totalClasses = state.data.classes.length;
  const totalExams = state.data.examinations.length;
  const gradingScale = appCfg.gradingScaleJson || DEFAULT_GRADING_SCALE;

  return `
    ${renderPublicTopBar()}
    <main class="landing-wrapper" id="top">
      <!-- HERO SECTION (DOSLA EDITORIAL FULL-WIDTH SPLIT) -->
      <section class="hero-section">
        <div class="hero-copy-column">
          <div>
            <p class="editorial-kicker">01. ${escapeHtml(school.name.toUpperCase())} · ACADEMIC SESSION ${escapeHtml(school.academicYear)}</p>
            <h1 class="hero-headline" style="margin-top:0.85rem;">
              Precision Academic Governance &amp; <span>Result Intelligence.</span>
            </h1>
            <p class="hero-lead" style="margin-top:1.25rem;">
              ${escapeHtml(school.campusSubtitle)}. Unified examination scheduling, faculty mark validation, and instant student marksheet generation engineered on zero-trust role security.
            </p>
            <div class="hero-cta-row" style="margin-top:2rem;">
              <button type="button" class="btn btn-primary" id="hero-access-portal-btn">Access Role Login Portal</button>
              <a href="#verification" class="btn btn-secondary">Verify Student Marksheet</a>
            </div>
          </div>
          <div class="hero-meta-inline">
            <span>Principal: ${escapeHtml(school.principalName)}</span>
            <span aria-hidden="true">·</span>
            <span>${escapeHtml(school.address)}</span>
            <span aria-hidden="true">·</span>
            <span class="mono-code">${escapeHtml(school.phone)}</span>
          </div>
        </div>

        <div class="hero-media-frame">
          <video
            src="${escapeHtml(ASSETS.heroCampusVideo)}"
            poster="${escapeHtml(ASSETS.heroCampus)}"
            autoplay
            loop
            muted
            playsinline
            preload="metadata"
            aria-label="Darul Huda Bengal Campus Aerial Video"
          ></video>
          <div class="hero-media-scrim">
            <div class="hero-media-caption">
              <h3>${escapeHtml(school.name)}</h3>
              <p>${escapeHtml(school.motto)}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 4-COLUMN KPI STRIP -->
      <section class="kpi-strip" aria-label="Campus Academic Statistics">
        <div class="kpi-block">
          <div class="kpi-number tabular-nums">${totalStudents}</div>
          <div class="kpi-title">Enrolled Scholars</div>
          <div class="kpi-sub">Active verified admission records</div>
        </div>
        <div class="kpi-block">
          <div class="kpi-number tabular-nums">${totalTeachers}</div>
          <div class="kpi-title">Academic Faculty</div>
          <div class="kpi-sub">Subject &amp; section assigned educators</div>
        </div>
        <div class="kpi-block">
          <div class="kpi-number tabular-nums">${totalClasses}</div>
          <div class="kpi-title">Collegiate Cohorts</div>
          <div class="kpi-sub">${state.data.sections.length} active section divisions</div>
        </div>
        <div class="kpi-block">
          <div class="kpi-number tabular-nums">${totalExams}</div>
          <div class="kpi-title">Published Examinations</div>
          <div class="kpi-sub">${state.data.marks.length} validated subject mark entries</div>
        </div>
      </section>

      <!-- WARM CREAM ASYMMETRIC ROLE PORTAL SHOWCASE -->
      <section class="cream-showcase-section" id="portals">
        <div class="cream-section-header">
          <div>
            <p class="editorial-kicker" style="color:#C84312;">02. STRICT ROLE-BASED ACCESS ARCHITECTURE</p>
            <h2>Three Dedicated Portals. Zero Unauthorized Overlap.</h2>
          </div>
          <p>
            Every account authenticates through a dedicated username-only security gate backed by Supabase Cloud persistence and role-scoped access control. Choose your institutional role to sign in.
          </p>
        </div>

        <div class="asymmetric-portal-grid">
          <article class="portal-role-card featured-dark">
            <div>
              <span class="portal-role-index">PORTAL 01 / FULL GOVERNANCE</span>
              <h3>Administrator Console</h3>
              <p>
                Complete institutional command over students, faculty assignments, classes, sections, subjects, examination rules, global marksheets, and live campus branding.
              </p>
            </div>
            <div>
              <div class="portal-feature-meta" style="margin-bottom:1.1rem;">
                Administrator: <span class="mono-code">@admin00798</span> · Direct Console Access
              </div>
              <button type="button" class="btn btn-primary" data-goto-role="admin">Sign In as Admin</button>
            </div>
          </article>

          <article class="portal-role-card">
            <div>
              <span class="portal-role-index">PORTAL 02 / FACULTY ACCESS</span>
              <h3>Teacher Workspace</h3>
              <p>
                Scoped strictly to assigned classes, sections, and subjects. Enter and update student examination marks with upper-bound validation and duplicate protection.
              </p>
            </div>
            <div>
              <div class="portal-feature-meta" style="margin-bottom:1.1rem;">
                Demo Faculty: <span class="mono-code">ustadh_farhan</span> · Assigned Mathematics &amp; Physics
              </div>
              <button type="button" class="btn btn-dark" data-goto-role="teacher">Sign In as Teacher</button>
            </div>
          </article>

          <article class="portal-role-card">
            <div>
              <span class="portal-role-index">PORTAL 03 / SCHOLAR ACCESS</span>
              <h3>Student Result Portal</h3>
              <p>
                Personal academic profile and official examination marksheets with subject-wise scores, percentage, GPA grade, and pass/fail status.
              </p>
            </div>
            <div>
              <div class="portal-feature-meta" style="margin-bottom:1.1rem;">
                Demo Scholar: <span class="mono-code">ahmad_r</span> · Adm No <span class="mono-code">DHBC-2026-001</span>
              </div>
              <button type="button" class="btn btn-dark" data-goto-role="student">Sign In as Student</button>
            </div>
          </article>
        </div>
      </section>

      <!-- INSTANT MARKSHEET VERIFICATION & GRADING MATRIX -->
      <section class="public-grading-section" id="verification">
        <div class="surface-panel">
          <p class="editorial-kicker">03. INSTANT RESULT VERIFICATION</p>
          <h3 style="margin-top:0.35rem;">Verify Student Marksheet by Admission Number</h3>
          <p class="panel-sub">
            Enter a valid Darul Huda Bengal Campus Admission Number (e.g., <span class="mono-code">DHBC-2026-001</span> or <span class="mono-code">DHBC-2026-003</span>) to preview published examination standing.
          </p>
          <form id="public-verify-form" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:1.5rem;">
            <label for="verify-adm-input" style="position:absolute;width:1px;height:1px;overflow:hidden;">Admission Number</label>
            <input
              type="text"
              id="verify-adm-input"
              class="form-input mono-code"
              style="flex:1;min-width:220px;"
              placeholder="e.g. DHBC-2026-001"
              value="${escapeHtml(state.publicVerifyAdmissionNo)}"
            />
            <button type="submit" class="btn btn-primary">Lookup Result</button>
          </form>
          ${renderPublicVerificationPreview()}
        </div>

        <div class="surface-panel" id="grading-rubric">
          <p class="editorial-kicker">04. CONFIGURED ASSESSMENT STANDARD</p>
          <h3 style="margin-top:0.35rem;">Institutional Grading &amp; Passing Criteria</h3>
          <p class="panel-sub">
            Configured dynamically by the Campus Administrator. Minimum pass threshold: <strong class="mono-code">${escapeHtml(appCfg.passPercentage)}%</strong> in every subject.
          </p>
          <div class="table-container">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Letter Grade</th>
                  <th>Descriptor</th>
                  <th class="num-col">Percentage Range</th>
                  <th class="num-col">Grade Point (GPA)</th>
                </tr>
              </thead>
              <tbody>
                ${gradingScale
                  .map(
                    (tier) => `
                  <tr>
                    <td class="mono-code"><strong>${escapeHtml(tier.grade)}</strong></td>
                    <td>${escapeHtml(tier.label)}</td>
                    <td class="num-col">${escapeHtml(tier.minPercentage)}% – ${escapeHtml(tier.maxPercentage)}%</td>
                    <td class="num-col">${Number(tier.gpa).toFixed(1)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>

    <footer class="public-footer" id="campus-info">
      <div>
        <strong>${escapeHtml(school.name)}</strong> · ${escapeHtml(school.address)} · <span class="mono-code">${escapeHtml(school.phone)}</span>
      </div>
      <div>
        <span>${escapeHtml(appCfg.appName)} Academic Portal · Powered by Supabase Cloud &amp; Role-Based Security</span>
      </div>
    </footer>
  `;
}

function renderPublicVerificationPreview() {
  if (!state.publicVerifyAdmissionNo) {
    return `<div style="font-size:0.84rem;color:var(--text-muted);">Try searching <button type="button" class="credential-fill-btn" id="quick-verify-btn">DHBC-2026-001</button> to see a live verified summary.</div>`;
  }
  const adm = state.publicVerifyAdmissionNo.trim().toUpperCase();
  const student = state.data.students.find((s) => s.admissionNo.toUpperCase() === adm);
  if (!student) {
    return `<div class="login-error-banner">No student record found matching Admission Number "${escapeHtml(state.publicVerifyAdmissionNo)}".</div>`;
  }
  const stuMarks = state.data.marks.filter((m) => m.studentId === student.id);
  const summary = calculateAggregateMarksheet(stuMarks, state.data.appSettings.gradingScaleJson);
  return `
    <div style="padding:1.25rem;border:1px solid var(--border-strong);border-radius:var(--radius-md);background:var(--bg-primary);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:0.75rem;">
        <div>
          <strong style="font-size:1.05rem;">${escapeHtml(student.fullName)}</strong>
          <div style="font-size:0.8rem;color:var(--text-muted);">
            Adm No: <span class="mono-code">${escapeHtml(student.admissionNo)}</span> · Roll: <span class="mono-code">${escapeHtml(student.rollNo)}</span> · ${escapeHtml(student.className)} (${escapeHtml(student.sectionName)})
          </div>
        </div>
        <span class="status-indicator ${summary.passed ? 'status-pass' : 'status-fail'}">
          ${summary.passed ? '▲ PASS' : '■ FAIL'} · Grade ${escapeHtml(summary.grade)}
        </span>
      </div>
      <div style="font-size:0.85rem;color:var(--text-secondary);" class="mono-code">
        Obtained: ${summary.totalObtainedMarks} / ${summary.totalMaxMarks} (${summary.percentage}%) · Subjects Evaluated: ${summary.subjectCount}
      </div>
    </div>
  `;
}

function renderLoginScreen() {
  const school = state.data.schoolSettings;
  const roleLabels = {
    admin: {
      title: 'Administrator Sign In',
      subtitle: 'Full campus governance, academic structure, and global settings.',
      illustrationHeading: 'Institutional Command & Academic Integrity.',
      illustrationCopy:
        'Manage student admissions, faculty assignments, grading rubrics, and school-wide examination records for Darul Huda Bengal Campus.'
    },
    teacher: {
      title: 'Faculty Sign In',
      subtitle: 'Access assigned classes, sections, subjects, and student mark entry.',
      illustrationHeading: 'Precision Assessment for Assigned Cohorts.',
      illustrationCopy:
        'Enter and validate examination marks within your authorized subjects and review real-time class performance summaries.'
    },
    student: {
      title: 'Scholar Sign In',
      subtitle: 'View your personal academic profile and official examination marksheets.',
      illustrationHeading: 'Your Verified Academic Record & Marksheets.',
      illustrationCopy:
        'Access subject-wise examination scores, cumulative percentage, letter grades, and printable official marksheets.'
    }
  };
  const currentMeta = roleLabels[state.loginRoleTab] || roleLabels.admin;

  return `
    ${renderPublicTopBar()}
    <section class="login-screen-backdrop">
      <div class="login-rounded-container">
        <!-- Left-Side Promotional Illustration Panel (Reference 2 Layout) -->
        <div class="login-illustration-panel">
          <img
            src="${escapeHtml(ASSETS.loginIllustration)}"
            alt="Golden-Hour Gathering at Darul Huda Grand Mosque Campus"
            class="login-art-img"
            referrerpolicy="no-referrer"
            onerror="this.style.display='none'"
          />
          <div class="login-illustration-scrim"></div>
          <div class="login-illustration-top">
            <div class="campus-crest-lockup">
              <div class="crest-monogram crest-monogram-logo">
                <img
                  src="${escapeHtml(getSafeLogoSrc(school.logoUrl, ASSETS.campusLogo))}"
                  alt="${escapeHtml(school.name)} Emblem"
                  class="crest-logo-img"
                  referrerpolicy="no-referrer"
                  onerror="this.parentElement.textContent='${escapeHtml(state.data.appSettings.logoText || 'DH')}'"
                />
              </div>
              <div>
                <div style="font-family:var(--font-display);font-weight:700;font-size:1.05rem;">${escapeHtml(school.name)}</div>
                <div style="font-size:0.78rem;color:rgba(255,255,255,0.72);">Academic Session ${escapeHtml(school.academicYear)}</div>
              </div>
            </div>
          </div>
          <div class="login-illustration-bottom">
            <p class="editorial-kicker" style="margin-bottom:0.5rem;">${escapeHtml(state.loginRoleTab.toUpperCase())} SECURITY GATE</p>
            <h2>${escapeHtml(currentMeta.illustrationHeading)}</h2>
            <p>${escapeHtml(currentMeta.illustrationCopy)}</p>
          </div>
        </div>

        <!-- Right-Side Login Form Panel (Username + Password + Show/Hide + Login Button ONLY) -->
        <div class="login-form-panel">
          <div class="login-form-header">
            <h1>${escapeHtml(currentMeta.title)}</h1>
            <p>${escapeHtml(currentMeta.subtitle)}</p>
          </div>

          <!-- Three Separate Login Sections: Admin | Teacher | Student -->
          <div class="role-selector-tabs" role="tablist" aria-label="Select Portal Role">
            <button
              type="button"
              role="tab"
              aria-selected="${state.loginRoleTab === 'admin'}"
              class="role-tab-btn ${state.loginRoleTab === 'admin' ? 'active' : ''}"
              data-login-tab="admin"
            >
              Admin
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="${state.loginRoleTab === 'teacher'}"
              class="role-tab-btn ${state.loginRoleTab === 'teacher' ? 'active' : ''}"
              data-login-tab="teacher"
            >
              Teacher
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="${state.loginRoleTab === 'student'}"
              class="role-tab-btn ${state.loginRoleTab === 'student' ? 'active' : ''}"
              data-login-tab="student"
            >
              Student
            </button>
          </div>

          ${
            state.loginError
              ? `<div class="login-error-banner" role="alert">${escapeHtml(state.loginError)}</div>`
              : ''
          }

          <form id="portal-login-form" novalidate>
            <div class="login-field-group">
              <label for="login-username-input">Username</label>
              <div class="login-input-wrap">
                <input
                  type="text"
                  id="login-username-input"
                  name="username"
                  class="login-input"
                  autocomplete="username"
                  placeholder="Enter your ${escapeHtml(state.loginRoleTab)} username"
                  required
                />
              </div>
            </div>

            <div class="login-field-group">
              <label for="login-password-input">Password</label>
              <div class="login-input-wrap">
                <input
                  type="${state.showPassword ? 'text' : 'password'}"
                  id="login-password-input"
                  name="password"
                  class="login-input"
                  style="padding-right:4.5rem;"
                  autocomplete="current-password"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  class="password-toggle-btn"
                  id="toggle-password-visibility-btn"
                  aria-label="${state.showPassword ? 'Hide password' : 'Show password'}"
                >
                  ${state.showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <button type="submit" class="login-submit-btn" id="login-submit-btn">
              Login to ${escapeHtml(state.loginRoleTab.charAt(0).toUpperCase() + state.loginRoleTab.slice(1))} Portal
            </button>
            <div class="login-forgot-row">
              <button type="button" class="login-forgot-link" id="forgot-password-help-btn">
                Forgot password?
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  `;
}

// ============================================================================
// 9. DASHBOARD SHELL & ROLE NAVIGATION
// ============================================================================
function getNavItemsForRole(role) {
  if (role === 'admin') {
    return [
      { id: 'overview', label: 'Dashboard Overview', count: null },
      { id: 'students', label: 'Student Management', count: state.data.students.length },
      { id: 'teachers', label: 'Teacher Management', count: state.data.teachers.length },
      { id: 'classes', label: 'Class Management', count: state.data.classes.length },
      { id: 'sections', label: 'Section Management', count: state.data.sections.length },
      { id: 'subjects', label: 'Subject Management', count: state.data.subjects.length },
      { id: 'examinations', label: 'Exams & Marks', count: state.data.examinations.length },
      { id: 'school', label: 'School Management', count: null },
      { id: 'settings', label: 'Application Settings', count: null },
      { id: 'profile', label: 'Admin Profile', count: null }
    ];
  }
  if (role === 'teacher') {
    return [
      { id: 'overview', label: 'Assigned Academic Access', count: null },
      { id: 'marks-entry', label: 'Marks Entry', count: null },
      { id: 'student-results', label: 'Student Results', count: null },
      { id: 'profile', label: 'My Faculty Profile', count: null }
    ];
  }
  return [
    { id: 'overview', label: 'My Marksheet & Results', count: null },
    { id: 'history', label: 'Result History', count: null },
    { id: 'profile', label: 'My Scholar Profile', count: null }
  ];
}

function renderDashboardShell() {
  const user = state.currentUser;
  const school = state.data.schoolSettings;
  const appCfg = state.data.appSettings;
  const navItems = getNavItemsForRole(user.role);
  const currentNavObj = navItems.find((n) => n.id === state.activeNav) || navItems[0];
  const initials = user.fullName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return `
    <div class="dashboard-shell">
      <!-- Responsive Sidebar -->
      <aside class="dashboard-sidebar ${state.sidebarOpen ? 'open' : ''}" aria-label="Workspace Sidebar Navigation">
        <div>
          <div class="sidebar-brand">
            <div class="crest-monogram crest-monogram-logo" style="width:40px;height:40px;">
              <img
                src="${escapeHtml(getSafeLogoSrc(school.logoUrl, ASSETS.campusLogo))}"
                alt="${escapeHtml(school.name)} Emblem"
                class="crest-logo-img"
                referrerpolicy="no-referrer"
                onerror="this.parentElement.textContent='${escapeHtml(appCfg.logoText || 'DH')}'"
              />
            </div>
            <div>
              <div class="sidebar-brand-title">${escapeHtml(appCfg.appName)}</div>
              <div class="sidebar-brand-sub">${escapeHtml(school.name)}</div>
            </div>
          </div>

          <div class="sidebar-nav-section-label">${escapeHtml(user.role.toUpperCase())} WORKSPACE</div>
          <ul class="sidebar-nav-list">
            ${navItems
              .map(
                (item) => `
              <li>
                <button
                  type="button"
                  class="sidebar-nav-btn ${state.activeNav === item.id ? 'active' : ''}"
                  data-nav-id="${escapeHtml(item.id)}"
                >
                  <span>${escapeHtml(item.label)}</span>
                  ${
                    item.count !== null
                      ? `<span class="mono-code" style="font-size:0.76rem;opacity:0.8;">${item.count}</span>`
                      : ''
                  }
                </button>
              </li>
            `
              )
              .join('')}
          </ul>
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-user-summary">
            ${
              user.avatarUrl
                ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.fullName)}" class="user-avatar-thumb" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
                : `<div class="user-avatar-thumb">${escapeHtml(initials)}</div>`
            }
            <div style="min-width:0;">
              <div style="font-size:0.86rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${escapeHtml(user.fullName)}
              </div>
              <div class="mono-code" style="font-size:0.74rem;color:var(--text-muted);">
                @${escapeHtml(user.username)} · ${escapeHtml(user.role)}
              </div>
            </div>
          </div>
          <div style="display:flex;gap:0.5rem;">
            <button type="button" class="btn btn-secondary btn-sm" style="flex:1;" id="sidebar-public-home-btn">Campus Home</button>
            <button type="button" class="btn btn-danger btn-sm" style="flex:1;" id="sidebar-logout-btn">Sign Out</button>
          </div>
        </div>
      </aside>

      <!-- Main Workspace Viewport -->
      <div class="dashboard-main">
        <header class="workspace-topbar">
          <div style="display:flex;align-items:center;gap:0.85rem;">
            <button type="button" class="btn btn-secondary btn-sm mobile-menu-btn" id="mobile-sidebar-toggle-btn" aria-label="Toggle Navigation Drawer">
              Menu
            </button>
            <div class="workspace-breadcrumb">
              <span>${escapeHtml(school.name)}</span>
              <span aria-hidden="true">/</span>
              <span>${escapeHtml(user.role.charAt(0).toUpperCase() + user.role.slice(1))} Portal</span>
              <span aria-hidden="true">/</span>
              <strong>${escapeHtml(currentNavObj.label)}</strong>
            </div>
          </div>

          <div class="workspace-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="topbar-profile-shortcut-btn">
              @${escapeHtml(user.username)}
            </button>
            <button type="button" class="btn btn-danger btn-sm" id="topbar-logout-btn">
              Sign Out
            </button>
          </div>
        </header>

        <main class="workspace-content">
          ${renderRoleWorkspaceContent()}
        </main>
      </div>
    </div>
  `;
}

function renderRoleWorkspaceContent() {
  const role = state.currentUser?.role;
  if (role === 'admin') return renderAdminWorkspace();
  if (role === 'teacher') return renderTeacherWorkspace();
  if (role === 'student') return renderStudentWorkspace();
  return '';
}

// ============================================================================
// 10. ADMIN DASHBOARD VIEWS (SECTIONS 6A – 6I)
// ============================================================================
function renderAdminWorkspace() {
  switch (state.activeNav) {
    case 'overview':
      return renderAdminOverview();
    case 'students':
      return renderAdminStudents();
    case 'teachers':
      return renderAdminTeachers();
    case 'classes':
      return renderAdminClasses();
    case 'sections':
      return renderAdminSections();
    case 'subjects':
      return renderAdminSubjects();
    case 'examinations':
      return renderAdminExaminationsAndMarks();
    case 'school':
      return renderAdminSchoolSettings();
    case 'settings':
      return renderAdminAppSettings();
    case 'profile':
      return renderUniversalProfileView();
    default:
      return renderAdminOverview();
  }
}

function renderAdminOverview() {
  const { students, teachers, classes, sections, subjects, examinations, marks, activityLogs } = state.data;
  const passCount = marks.filter((m) => m.passed).length;
  const passRate = marks.length > 0 ? Math.round((passCount / marks.length) * 100) : 100;

  return `
    <div class="view-header-row">
      <div>
        <h1>Administrator Command Overview</h1>
        <p>Real-time institutional telemetry and academic records for ${escapeHtml(state.data.schoolSettings.name)}.</p>
      </div>
      <div style="display:flex;gap:0.65rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" data-quick-action="add-student">+ Enroll Student</button>
        <button type="button" class="btn btn-secondary" data-quick-action="add-teacher">+ Add Teacher</button>
        <button type="button" class="btn btn-secondary" data-quick-action="add-exam">+ Create Exam</button>
      </div>
    </div>

    ${
      isCloudConnected && (cloudSetupNeeded || state.cloudAuthStatus === 'setup_needed')
        ? `
      <div class="surface-panel" style="margin-bottom:1.5rem;border-color:rgba(255,100,45,0.45);display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
        <div style="flex:1;min-width:260px;">
          <h3 style="margin-bottom:0.25rem;">One-Time Supabase Table Setup Required for Cross-Device Sync</h3>
          <p class="panel-sub" style="margin-bottom:0;">
            Copy the SQL setup script and run it once in <strong>Supabase Dashboard → SQL Editor → New Query</strong>, then click Verify Sync to save all data across devices.
          </p>
        </div>
        <div style="display:flex;gap:0.65rem;flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-supabase-sql">Copy SQL Script</button>
          <button type="button" class="btn btn-primary btn-sm" id="btn-retry-cloud-sync">
            ${state.cloudSyncBusy ? 'Verifying...' : 'Verify & Sync to Supabase'}
          </button>
        </div>
      </div>
    `
        : ''
    }

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Students</div>
        <div class="stat-value tabular-nums">${students.length}</div>
        <div class="stat-meta">Unique admission numbers verified</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Teachers</div>
        <div class="stat-value tabular-nums">${teachers.length}</div>
        <div class="stat-meta">Active faculty accounts</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Classes</div>
        <div class="stat-value tabular-nums">${classes.length}</div>
        <div class="stat-meta">Session ${escapeHtml(state.data.schoolSettings.academicYear)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Sections</div>
        <div class="stat-value tabular-nums">${sections.length}</div>
        <div class="stat-meta">Assigned to academic cohorts</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Subjects</div>
        <div class="stat-value tabular-nums">${subjects.length}</div>
        <div class="stat-meta">Mapped to classes &amp; teachers</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Exams</div>
        <div class="stat-value tabular-nums">${examinations.length}</div>
        <div class="stat-meta">${passRate}% subject pass rate (${marks.length} marks)</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1.25fr 0.75fr;gap:1.5rem;align-items:start;">
      <div class="surface-panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h3>Recent Examination Results</h3>
          <button type="button" class="btn btn-secondary btn-sm" data-nav-jump="examinations">Manage All Marks</button>
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Scholar</th>
                <th>Subject</th>
                <th class="num-col">Marks</th>
                <th class="num-col">Grade</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${marks
                .slice(0, 6)
                .map(
                  (m) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(m.studentName)}</strong>
                    <div class="mono-code" style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(m.admissionNo)}</div>
                  </td>
                  <td>${escapeHtml(m.subjectName)}</td>
                  <td class="num-col">${m.obtainedMarks} / ${m.maxMarks}</td>
                  <td class="num-col"><strong>${escapeHtml(m.grade)}</strong> (${m.percentage}%)</td>
                  <td>
                    <span class="status-indicator ${m.passed ? 'status-pass' : 'status-fail'}">
                      ${m.passed ? '▲ PASS' : '■ FAIL'}
                    </span>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="surface-panel">
        <h3 style="margin-bottom:1rem;">Recent Campus Activities</h3>
        <div style="display:flex;flex-direction:column;gap:0.85rem;">
          ${activityLogs
            .slice(0, 6)
            .map(
              (log) => `
            <div style="padding-bottom:0.85rem;border-bottom:1px solid var(--border-subtle);font-size:0.85rem;">
              <div style="font-weight:600;color:var(--text-primary);">${escapeHtml(log.action)}</div>
              <div style="font-size:0.76rem;color:var(--text-muted);margin-top:0.2rem;">
                ${escapeHtml(log.actorName)} (${escapeHtml(log.actorRole)}) · ${escapeHtml(log.category)}
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

// 6B. STUDENT MANAGEMENT
function renderAdminStudents() {
  const { students, classes, sections } = state.data;
  const search = state.studentSearch.trim().toLowerCase();

  const filtered = students.filter((s) => {
    if (state.studentClassFilter !== 'all' && s.classId !== state.studentClassFilter) return false;
    if (state.studentSectionFilter !== 'all' && s.sectionId !== state.studentSectionFilter) return false;
    if (search) {
      const hay = `${s.fullName} ${s.admissionNo} ${s.rollNo} ${s.username}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (state.studentPage > totalPages) state.studentPage = totalPages;
  const paged = filtered.slice((state.studentPage - 1) * pageSize, state.studentPage * pageSize);

  return `
    <div class="view-header-row">
      <div>
        <h1>Student Information System</h1>
        <p>Manage scholar enrollments, unique admission numbers, class/section roll numbers, and login accounts.</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-open-add-student">+ Enroll New Student</button>
    </div>

    <div class="filter-toolbar">
      <div class="filter-controls-group">
        <label for="stu-search-input" style="position:absolute;width:1px;height:1px;overflow:hidden;">Search Students</label>
        <input
          type="search"
          id="stu-search-input"
          class="form-input"
          style="min-width:240px;flex:1;"
          placeholder="Search name, admission no, roll no, username..."
          value="${escapeHtml(state.studentSearch)}"
        />
        <label for="stu-class-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;">Filter by Class</label>
        <select id="stu-class-filter" class="form-select">
          <option value="all">All Classes</option>
          ${classes
            .map(
              (c) => `<option value="${escapeHtml(c.id)}" ${state.studentClassFilter === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            )
            .join('')}
        </select>
        <label for="stu-section-filter" style="position:absolute;width:1px;height:1px;overflow:hidden;">Filter by Section</label>
        <select id="stu-section-filter" class="form-select">
          <option value="all">All Sections</option>
          ${sections
            .map(
              (sec) => `<option value="${escapeHtml(sec.id)}" ${state.studentSectionFilter === sec.id ? 'selected' : ''}>${escapeHtml(sec.name)} (${escapeHtml(sec.className)})</option>`
            )
            .join('')}
        </select>
      </div>
    </div>

    <div class="table-container">
      ${
        paged.length === 0
          ? `<div class="empty-state-box"><h3>No matching student records</h3><p>Adjust your search filters or enroll a new scholar.</p></div>`
          : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Admission No</th>
              <th>Roll No</th>
              <th>Scholar Name</th>
              <th>Username</th>
              <th>Class &amp; Section</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${paged
              .map(
                (stu) => `
              <tr>
                <td class="mono-code"><strong>${escapeHtml(stu.admissionNo)}</strong></td>
                <td class="mono-code">${escapeHtml(stu.rollNo)}</td>
                <td><strong>${escapeHtml(stu.fullName)}</strong></td>
                <td class="mono-code">@${escapeHtml(stu.username)}</td>
                <td>${escapeHtml(stu.className)} · ${escapeHtml(stu.sectionName)}</td>
                <td>
                  <span class="status-indicator ${stu.status === 'active' ? 'status-pass' : 'status-warn'}">
                    ${stu.status === 'active' ? '▲ ACTIVE' : '● ' + escapeHtml(stu.status.toUpperCase())}
                  </span>
                </td>
                <td>
                  <div class="table-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-view-marksheet-stu="${escapeHtml(stu.id)}" aria-label="View Marksheet for ${escapeHtml(stu.fullName)}">Marksheet</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-edit-stu="${escapeHtml(stu.id)}" aria-label="Edit ${escapeHtml(stu.fullName)}">Edit</button>
                    <button type="button" class="btn btn-danger btn-sm" data-delete-stu="${escapeHtml(stu.id)}" aria-label="Delete ${escapeHtml(stu.fullName)}">Delete</button>
                  </div>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
        <div class="pagination-bar">
          <span>Showing ${paged.length} of ${filtered.length} students (Page ${state.studentPage} of ${totalPages})</span>
          <div style="display:flex;gap:0.5rem;">
            <button type="button" class="btn btn-secondary btn-sm" id="stu-prev-page" ${state.studentPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button type="button" class="btn btn-secondary btn-sm" id="stu-next-page" ${state.studentPage >= totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      `
      }
    </div>
  `;
}

// 6C. TEACHER MANAGEMENT
function renderAdminTeachers() {
  const { teachers, classes, sections, subjects } = state.data;

  return `
    <div class="view-header-row">
      <div>
        <h1>Teacher &amp; Academic Assignment Management</h1>
        <p>Create faculty login accounts and assign authorized classes, sections, and subjects.</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-open-add-teacher">+ Add Faculty Member</button>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Employee ID</th>
            <th>Faculty Name &amp; Designation</th>
            <th>Username</th>
            <th>Assigned Classes &amp; Sections</th>
            <th>Assigned Subjects</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${teachers
            .map((t) => {
              const clsNames = t.assignedClassIds
                .map((cid) => classes.find((c) => c.id === cid)?.name)
                .filter(Boolean)
                .join(', ');
              const secNames = t.assignedSectionIds
                .map((sid) => sections.find((s) => s.id === sid)?.name)
                .filter(Boolean)
                .join(', ');
              const subNames = t.assignedSubjectIds
                .map((subId) => subjects.find((s) => s.id === subId)?.name)
                .filter(Boolean)
                .join(', ');
              return `
                <tr>
                  <td class="mono-code"><strong>${escapeHtml(t.employeeId)}</strong></td>
                  <td>
                    <strong>${escapeHtml(t.fullName)}</strong>
                    <div style="font-size:0.78rem;color:var(--text-muted);">${escapeHtml(t.designation)}</div>
                  </td>
                  <td class="mono-code">@${escapeHtml(t.username)}</td>
                  <td style="font-size:0.82rem;">
                    <div><strong>Classes:</strong> ${escapeHtml(clsNames || 'None')}</div>
                    <div style="color:var(--text-muted);"><strong>Sections:</strong> ${escapeHtml(secNames || 'None')}</div>
                  </td>
                  <td style="font-size:0.82rem;">${escapeHtml(subNames || 'No subjects assigned')}</td>
                  <td>
                    <div class="table-actions">
                      <button type="button" class="btn btn-secondary btn-sm" data-edit-teacher="${escapeHtml(t.id)}" aria-label="Edit ${escapeHtml(t.fullName)}">Edit &amp; Assign</button>
                      <button type="button" class="btn btn-danger btn-sm" data-delete-teacher="${escapeHtml(t.id)}" aria-label="Delete ${escapeHtml(t.fullName)}">Delete</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 6D. CLASS MANAGEMENT
function renderAdminClasses() {
  const { classes, sections, students } = state.data;

  return `
    <div class="view-header-row">
      <div>
        <h1>Class Management</h1>
        <p>Create and configure academic classes and monitor enrolled student distribution.</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-open-add-class">+ Create Class</button>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Class Name</th>
            <th>Academic Year</th>
            <th class="num-col">Sections</th>
            <th class="num-col">Enrolled / Capacity</th>
            <th>Description</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${classes
            .map((cls) => {
              const secCount = sections.filter((s) => s.classId === cls.id).length;
              const stuCount = students.filter((s) => s.classId === cls.id).length;
              return `
                <tr>
                  <td class="mono-code"><strong>${escapeHtml(cls.code)}</strong></td>
                  <td><strong>${escapeHtml(cls.name)}</strong></td>
                  <td class="mono-code">${escapeHtml(cls.academicYear)}</td>
                  <td class="num-col">${secCount}</td>
                  <td class="num-col">${stuCount} / ${cls.capacity}</td>
                  <td style="color:var(--text-muted);font-size:0.84rem;">${escapeHtml(cls.description || '—')}</td>
                  <td>
                    <div class="table-actions">
                      <button type="button" class="btn btn-secondary btn-sm" data-edit-class="${escapeHtml(cls.id)}" aria-label="Edit ${escapeHtml(cls.name)}">Edit</button>
                      <button type="button" class="btn btn-danger btn-sm" data-delete-class="${escapeHtml(cls.id)}" aria-label="Delete ${escapeHtml(cls.name)}">Delete</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 6E. SECTION MANAGEMENT
function renderAdminSections() {
  const { sections, students } = state.data;

  return `
    <div class="view-header-row">
      <div>
        <h1>Section Management</h1>
        <p>Assign sections to classes, manage lecture halls, and organize students by section.</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-open-add-section">+ Create Section</button>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Section Name</th>
            <th>Assigned Class</th>
            <th>Room / Hall</th>
            <th class="num-col">Students / Capacity</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sections
            .map((sec) => {
              const stuCount = students.filter((s) => s.sectionId === sec.id).length;
              return `
                <tr>
                  <td><strong>${escapeHtml(sec.name)}</strong></td>
                  <td>${escapeHtml(sec.className)}</td>
                  <td class="mono-code">${escapeHtml(sec.roomNo)}</td>
                  <td class="num-col">${stuCount} / ${sec.capacity}</td>
                  <td>
                    <div class="table-actions">
                      <button type="button" class="btn btn-secondary btn-sm" data-edit-section="${escapeHtml(sec.id)}" aria-label="Edit ${escapeHtml(sec.name)}">Edit</button>
                      <button type="button" class="btn btn-danger btn-sm" data-delete-section="${escapeHtml(sec.id)}" aria-label="Delete ${escapeHtml(sec.name)}">Delete</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 6F. SUBJECT MANAGEMENT
function renderAdminSubjects() {
  const { subjects } = state.data;

  return `
    <div class="view-header-row">
      <div>
        <h1>Subject Curriculum Management</h1>
        <p>Configure subjects, assign them to classes and faculty, and define default mark bounds.</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-open-add-subject">+ Add Subject</button>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Subject Code</th>
            <th>Subject Title</th>
            <th>Assigned Class</th>
            <th>Assigned Teacher</th>
            <th class="num-col">Max Marks</th>
            <th class="num-col">Pass Marks</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${subjects
            .map(
              (sub) => `
            <tr>
              <td class="mono-code"><strong>${escapeHtml(sub.code)}</strong></td>
              <td><strong>${escapeHtml(sub.name)}</strong></td>
              <td>${escapeHtml(sub.className)}</td>
              <td>${escapeHtml(sub.teacherName)}</td>
              <td class="num-col">${sub.maxMarks}</td>
              <td class="num-col">${sub.passMarks}</td>
              <td>
                <div class="table-actions">
                  <button type="button" class="btn btn-secondary btn-sm" data-edit-subject="${escapeHtml(sub.id)}" aria-label="Edit ${escapeHtml(sub.name)}">Edit</button>
                  <button type="button" class="btn btn-danger btn-sm" data-delete-subject="${escapeHtml(sub.id)}" aria-label="Delete ${escapeHtml(sub.name)}">Delete</button>
                </div>
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 6G. EXAMINATIONS & MARKS MANAGEMENT
function renderAdminExaminationsAndMarks() {
  const { examinations, marks, classes, sections, subjects } = state.data;
  const search = state.marksSearch.trim().toLowerCase();

  const filteredMarks = marks.filter((m) => {
    if (state.marksExamFilter !== 'all' && m.examId !== state.marksExamFilter) return false;
    if (state.marksClassFilter !== 'all' && m.classId !== state.marksClassFilter) return false;
    if (state.marksSectionFilter !== 'all' && m.sectionId !== state.marksSectionFilter) return false;
    if (state.marksSubjectFilter !== 'all' && m.subjectId !== state.marksSubjectFilter) return false;
    if (search) {
      const hay = `${m.studentName} ${m.admissionNo} ${m.rollNo} ${m.subjectName} ${m.examName}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  return `
    <div class="view-header-row">
      <div>
        <h1>Examination &amp; Marks Management</h1>
        <p>Create examinations, lock/publish results, and audit or edit student marks across all cohorts.</p>
      </div>
      <div style="display:flex;gap:0.75rem;">
        <button type="button" class="btn btn-secondary" id="btn-open-add-exam">+ Create Examination</button>
        <button type="button" class="btn btn-primary" id="btn-open-add-mark">+ Add / Update Mark</button>
      </div>
    </div>

    <!-- Examinations Table -->
    <div class="surface-panel" style="margin-bottom:2rem;">
      <h3 style="margin-bottom:1rem;">Scheduled Examinations</h3>
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Examination Name</th>
              <th>Term &amp; Year</th>
              <th>Cohort (Class &amp; Section)</th>
              <th class="num-col">Max / Pass</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${examinations
              .map(
                (ex) => `
              <tr>
                <td><strong>${escapeHtml(ex.name)}</strong></td>
                <td>${escapeHtml(ex.term)} · <span class="mono-code">${escapeHtml(ex.academicYear)}</span></td>
                <td>${escapeHtml(ex.className)} · ${escapeHtml(ex.sectionName)}</td>
                <td class="num-col">${ex.maxMarks} / ${ex.passMarks}</td>
                <td>
                  <span class="status-indicator ${ex.status === 'published' ? 'status-pass' : ex.status === 'locked' ? 'status-fail' : 'status-warn'}">
                    ${ex.status === 'published' ? '▲ PUBLISHED' : ex.status === 'locked' ? '■ LOCKED' : '● ' + escapeHtml(ex.status.toUpperCase())}
                  </span>
                </td>
                <td>
                  <div class="table-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-edit-exam="${escapeHtml(ex.id)}">Edit</button>
                    <button type="button" class="btn btn-danger btn-sm" data-delete-exam="${escapeHtml(ex.id)}">Delete</button>
                  </div>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Marks Ledger Filter Bar -->
    <div class="filter-toolbar">
      <div class="filter-controls-group">
        <input
          type="search"
          id="marks-search-input"
          class="form-input"
          style="min-width:200px;flex:1;"
          placeholder="Search student, admission no, roll no..."
          value="${escapeHtml(state.marksSearch)}"
          aria-label="Search Marks"
        />
        <select id="marks-exam-filter" class="form-select" aria-label="Filter by Examination">
          <option value="all">All Examinations</option>
          ${examinations
            .map((e) => `<option value="${escapeHtml(e.id)}" ${state.marksExamFilter === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`)
            .join('')}
        </select>
        <select id="marks-class-filter" class="form-select" aria-label="Filter Marks by Class">
          <option value="all">All Classes</option>
          ${classes
            .map((c) => `<option value="${escapeHtml(c.id)}" ${state.marksClassFilter === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
            .join('')}
        </select>
        <select id="marks-section-filter" class="form-select" aria-label="Filter Marks by Section">
          <option value="all">All Sections</option>
          ${sections
            .map((s) => `<option value="${escapeHtml(s.id)}" ${state.marksSectionFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
            .join('')}
        </select>
        <select id="marks-subject-filter" class="form-select" aria-label="Filter Marks by Subject">
          <option value="all">All Subjects</option>
          ${subjects
            .map((sub) => `<option value="${escapeHtml(sub.id)}" ${state.marksSubjectFilter === sub.id ? 'selected' : ''}>${escapeHtml(sub.name)}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <div class="table-container">
      ${
        filteredMarks.length === 0
          ? `<div class="empty-state-box"><h3>No marks match current filters</h3><p>Add a mark entry or clear filters above.</p></div>`
          : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Scholar (Adm / Roll)</th>
              <th>Examination</th>
              <th>Subject</th>
              <th class="num-col">Obtained / Max</th>
              <th class="num-col">Percentage</th>
              <th class="num-col">Grade</th>
              <th>Result</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filteredMarks
              .map(
                (m) => `
              <tr>
                <td>
                  <strong>${escapeHtml(m.studentName)}</strong>
                  <div class="mono-code" style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(m.admissionNo)} · Roll ${escapeHtml(m.rollNo)}</div>
                </td>
                <td style="font-size:0.83rem;">${escapeHtml(m.examName)}</td>
                <td><strong>${escapeHtml(m.subjectName)}</strong></td>
                <td class="num-col">${m.obtainedMarks} / ${m.maxMarks}</td>
                <td class="num-col">${m.percentage}%</td>
                <td class="num-col"><strong>${escapeHtml(m.grade)}</strong></td>
                <td>
                  <span class="status-indicator ${m.passed ? 'status-pass' : 'status-fail'}">
                    ${m.passed ? '▲ PASS' : '■ FAIL'}
                  </span>
                </td>
                <td>
                  <div class="table-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-edit-mark="${escapeHtml(m.id)}">Edit</button>
                    <button type="button" class="btn btn-danger btn-sm" data-delete-mark="${escapeHtml(m.id)}">Delete</button>
                  </div>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      `
      }
    </div>
  `;
}

function getSchoolLogoSourceLabel(url) {
  const val = String(url || '').trim();
  if (!val || val === ASSETS.campusLogo) return 'Default Campus Emblem';
  if (val.startsWith('data:image/')) return 'Uploaded Image (Cloud-Ready)';
  if (isForeignBlobUrl(val)) return 'Temporary blob: URL (Upload image file instead)';
  return 'Custom Image URL';
}

// 6H. SCHOOL MANAGEMENT
function renderAdminSchoolSettings() {
  const s = state.data.schoolSettings;
  const activeLogo = getSafeLogoSrc(s.logoUrl, ASSETS.campusLogo);

  return `
    <div class="view-header-row">
      <div>
        <h1>School Branding &amp; Institutional Information</h1>
        <p>Configure official campus details displayed on public pages and student marksheets.</p>
      </div>
    </div>

    <div class="surface-panel" style="max-width:820px;">
      <form id="form-school-settings">
        <div class="form-field">
          <label for="school-logo-input">Official School Logo (Upload File or Paste URL)</label>
          <div class="school-logo-uploader">
            <div class="school-logo-preview-box">
              <img
                id="school-logo-preview-img"
                src="${escapeHtml(activeLogo)}"
                alt="${escapeHtml(s.name)} Logo Preview"
                referrerpolicy="no-referrer"
              />
            </div>
            <div class="school-logo-controls">
              <div class="school-logo-action-row">
                <input type="file" id="school-logo-file-input" accept="image/*" class="sr-only-file-input" />
                <label for="school-logo-file-input" class="btn btn-secondary btn-sm school-logo-upload-label">
                  Upload Logo Image
                </label>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-reset-school-logo">
                  Reset Default
                </button>
                <span id="school-logo-source-status" class="mono-code" style="font-size:0.75rem;color:var(--text-muted);">
                  ${escapeHtml(getSchoolLogoSourceLabel(s.logoUrl))}
                </span>
              </div>
              <input
                type="text"
                id="school-logo-input"
                class="form-input"
                style="width:100%;"
                value="${escapeHtml(s.logoUrl || '')}"
                placeholder="https://example.com/logo.png or upload a file above"
              />
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.35rem;">
                Supports PNG, JPG, WebP, or SVG. Uploaded logos are automatically optimized for fast cross-device Supabase sync.
              </div>
            </div>
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-field">
            <label for="school-name-input">School Name</label>
            <input type="text" id="school-name-input" class="form-input" value="${escapeHtml(s.name)}" required />
          </div>
          <div class="form-field">
            <label for="school-year-input">Current Academic Year</label>
            <input type="text" id="school-year-input" class="form-input mono-code" value="${escapeHtml(s.academicYear)}" required />
          </div>
        </div>

        <div class="form-field">
          <label for="school-subtitle-input">Campus Subtitle / Affiliation</label>
          <input type="text" id="school-subtitle-input" class="form-input" value="${escapeHtml(s.campusSubtitle)}" required />
        </div>

        <div class="form-grid-2">
          <div class="form-field">
            <label for="school-principal-input">Principal / Head of Institution</label>
            <input type="text" id="school-principal-input" class="form-input" value="${escapeHtml(s.principalName || '')}" />
          </div>
          <div class="form-field">
            <label for="school-phone-input">Official Phone Number</label>
            <input type="text" id="school-phone-input" class="form-input mono-code" value="${escapeHtml(s.phone)}" required />
          </div>
        </div>

        <div class="form-grid-2">
          <div class="form-field">
            <label for="school-email-input">Registrar Email</label>
            <input type="email" id="school-email-input" class="form-input" value="${escapeHtml(s.email || '')}" />
          </div>
          <div class="form-field">
            <label for="school-address-input">Campus Address</label>
            <input type="text" id="school-address-input" class="form-input" value="${escapeHtml(s.address)}" required />
          </div>
        </div>

        <div class="form-field">
          <label for="school-motto-input">Institutional Motto</label>
          <input type="text" id="school-motto-input" class="form-input" value="${escapeHtml(s.motto || '')}" />
        </div>

        <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;">
          <button type="submit" class="btn btn-primary">Save School Branding</button>
        </div>
      </form>
    </div>
  `;
}

// 6I. APPLICATION SETTINGS
function renderAdminAppSettings() {
  const cfg = state.data.appSettings;
  const gradingScale = cfg.gradingScaleJson || DEFAULT_GRADING_SCALE;

  return `
    <div class="view-header-row">
      <div>
        <h1>Application Customization &amp; Academic Rules</h1>
        <p>Customize portal branding, DOSLA theme mode, accent palette, and automated grading rules.</p>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start;">
      <div class="surface-panel">
        <h3>Appearance &amp; Portal Identity</h3>
        <p class="panel-sub">Changes apply immediately and persist across devices in Supabase.</p>
        <form id="form-app-settings">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="app-name-input">Application Name</label>
              <input type="text" id="app-name-input" class="form-input" value="${escapeHtml(cfg.appName)}" required />
            </div>
            <div class="form-field">
              <label for="app-logo-text-input">Monogram Emblem (2–4 chars)</label>
              <input type="text" id="app-logo-text-input" class="form-input mono-code" maxlength="4" value="${escapeHtml(cfg.logoText)}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="app-theme-select">Portal Surface Theme</label>
              <select id="app-theme-select" class="form-select">
                <option value="dark" ${cfg.themeMode === 'dark' ? 'selected' : ''}>DOSLA Deep Charcoal (#111111)</option>
                <option value="cream" ${cfg.themeMode === 'cream' ? 'selected' : ''}>DOSLA Warm Editorial Cream (#F5F0E8)</option>
              </select>
            </div>
            <div class="form-field">
              <label for="app-accent-input">Primary Accent Color (Hex)</label>
              <input type="text" id="app-accent-input" class="form-input mono-code" value="${escapeHtml(cfg.accentColor)}" required />
            </div>
          </div>

          <div class="form-field">
            <label for="app-pass-pct-input">Default Minimum Pass Percentage (%)</label>
            <input type="number" id="app-pass-pct-input" class="form-input mono-code" min="1" max="100" value="${cfg.passPercentage}" required />
          </div>

          <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;gap:0.75rem;">
            <button type="button" class="btn btn-secondary" id="btn-reset-default-theme">Reset Default Palette</button>
            <button type="submit" class="btn btn-primary">Save Application Settings</button>
          </div>
        </form>
      </div>

      <div class="surface-panel">
        <h3>Configured Grading Scale</h3>
        <p class="panel-sub">Used automatically across all marksheets and teacher mark entries.</p>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Grade</th>
                <th>Label</th>
                <th class="num-col">Min %</th>
                <th class="num-col">GPA</th>
              </tr>
            </thead>
            <tbody>
              ${gradingScale
                .map(
                  (g) => `
                <tr>
                  <td class="mono-code"><strong>${escapeHtml(g.grade)}</strong></td>
                  <td>${escapeHtml(g.label)}</td>
                  <td class="num-col">${g.minPercentage}%</td>
                  <td class="num-col">${Number(g.gpa).toFixed(1)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// 11. TEACHER DASHBOARD VIEWS (SECTION 7)
// ============================================================================
function renderTeacherWorkspace() {
  const teacher = state.data.teachers.find((t) => t.userId === state.currentUser.uid);
  if (!teacher) {
    return `<div class="empty-state-box"><h3>Faculty record not linked</h3><p>Contact the Campus Administrator to assign your faculty profile.</p></div>`;
  }

  switch (state.activeNav) {
    case 'overview':
      return renderTeacherAssignedAccess(teacher);
    case 'marks-entry':
      return renderTeacherMarksEntry(teacher);
    case 'student-results':
      return renderTeacherStudentResults(teacher);
    case 'profile':
      return renderUniversalProfileView();
    default:
      return renderTeacherAssignedAccess(teacher);
  }
}

function renderTeacherAssignedAccess(teacher) {
  const assignedClasses = state.data.classes.filter((c) => teacher.assignedClassIds.includes(c.id));
  const assignedSections = state.data.sections.filter((s) => teacher.assignedSectionIds.includes(s.id));
  const assignedSubjects = state.data.subjects.filter((sub) => teacher.assignedSubjectIds.includes(sub.id));
  const assignedStudents = state.data.students.filter(
    (stu) => teacher.assignedClassIds.includes(stu.classId) && teacher.assignedSectionIds.includes(stu.sectionId)
  );

  return `
    <div class="view-header-row">
      <div>
        <h1>Welcome, ${escapeHtml(teacher.fullName)}</h1>
        <p>${escapeHtml(teacher.designation)} · Employee ID <span class="mono-code">${escapeHtml(teacher.employeeId)}</span></p>
      </div>
      <button type="button" class="btn btn-primary" data-nav-jump="marks-entry">Open Marks Entry Sheet</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Assigned Classes</div>
        <div class="stat-value tabular-nums">${assignedClasses.length}</div>
        <div class="stat-meta">${escapeHtml(assignedClasses.map((c) => c.code).join(', ') || 'None')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Assigned Sections</div>
        <div class="stat-value tabular-nums">${assignedSections.length}</div>
        <div class="stat-meta">${escapeHtml(assignedSections.map((s) => s.name).join(', ') || 'None')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Assigned Subjects</div>
        <div class="stat-value tabular-nums">${assignedSubjects.length}</div>
        <div class="stat-meta">${escapeHtml(assignedSubjects.map((s) => s.code).join(', ') || 'None')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Authorized Students</div>
        <div class="stat-value tabular-nums">${assignedStudents.length}</div>
        <div class="stat-meta">Within your assigned sections</div>
      </div>
    </div>

    <div class="surface-panel">
      <h3 style="margin-bottom:1rem;">Authorized Students in Your Assigned Cohorts</h3>
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Admission No</th>
              <th>Roll No</th>
              <th>Scholar Name</th>
              <th>Class</th>
              <th>Section</th>
            </tr>
          </thead>
          <tbody>
            ${assignedStudents
              .map(
                (stu) => `
              <tr>
                <td class="mono-code"><strong>${escapeHtml(stu.admissionNo)}</strong></td>
                <td class="mono-code">${escapeHtml(stu.rollNo)}</td>
                <td><strong>${escapeHtml(stu.fullName)}</strong></td>
                <td>${escapeHtml(stu.className)}</td>
                <td>${escapeHtml(stu.sectionName)}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTeacherMarksEntry(teacher) {
  const assignedClasses = state.data.classes.filter((c) => teacher.assignedClassIds.includes(c.id));
  const assignedSections = state.data.sections.filter(
    (s) => teacher.assignedSectionIds.includes(s.id) && (!state.entryClassId || s.classId === state.entryClassId)
  );
  const assignedSubjects = state.data.subjects.filter(
    (sub) => teacher.assignedSubjectIds.includes(sub.id) && (!state.entryClassId || sub.classId === state.entryClassId)
  );
  const availableExams = state.data.examinations.filter(
    (ex) => !state.entryClassId || ex.classId === state.entryClassId
  );

  const selectedClassId = state.entryClassId || assignedClasses[0]?.id || '';
  const selectedSectionId = state.entrySectionId || assignedSections[0]?.id || '';
  const selectedSubjectId = state.entrySubjectId || assignedSubjects[0]?.id || '';
  const selectedExamId = state.entryExamId || availableExams[0]?.id || '';

  const selectedSubject = state.data.subjects.find((s) => s.id === selectedSubjectId);
  const selectedExam = state.data.examinations.find((e) => e.id === selectedExamId);
  const maxMarks = selectedSubject?.maxMarks || selectedExam?.maxMarks || 100;
  const passMarks = selectedSubject?.passMarks || selectedExam?.passMarks || 40;

  const cohortStudents = state.data.students.filter(
    (stu) => stu.classId === selectedClassId && stu.sectionId === selectedSectionId
  );

  return `
    <div class="view-header-row">
      <div>
        <h1>Faculty Marks Entry &amp; Validation</h1>
        <p>Select your assigned class, section, subject, and examination to enter or update student marks.</p>
      </div>
    </div>

    <div class="filter-toolbar">
      <div class="filter-controls-group">
        <div>
          <label for="tch-entry-class" style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.2rem;">Assigned Class</label>
          <select id="tch-entry-class" class="form-select">
            ${assignedClasses
              .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === selectedClassId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label for="tch-entry-section" style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.2rem;">Assigned Section</label>
          <select id="tch-entry-section" class="form-select">
            ${assignedSections
              .map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === selectedSectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label for="tch-entry-subject" style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.2rem;">Assigned Subject</label>
          <select id="tch-entry-subject" class="form-select">
            ${assignedSubjects
              .map((sub) => `<option value="${escapeHtml(sub.id)}" ${sub.id === selectedSubjectId ? 'selected' : ''}>${escapeHtml(sub.name)} (Max ${sub.maxMarks})</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label for="tch-entry-exam" style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:0.2rem;">Examination</label>
          <select id="tch-entry-exam" class="form-select">
            ${availableExams
              .map((ex) => `<option value="${escapeHtml(ex.id)}" ${ex.id === selectedExamId ? 'selected' : ''}>${escapeHtml(ex.name)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
    </div>

    ${
      !selectedSubject || !selectedExam
        ? `<div class="empty-state-box"><h3>Select an assigned subject and examination</h3><p>Choose from the dropdowns above to load your student mark sheet.</p></div>`
        : `
      <form id="teacher-batch-marks-form">
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Roll No</th>
                <th>Admission No</th>
                <th>Scholar Name</th>
                <th class="num-col">Max / Pass</th>
                <th style="width:160px;">Obtained Marks</th>
                <th>Remarks</th>
                <th>Current Standing</th>
              </tr>
            </thead>
            <tbody>
              ${cohortStudents
                .map((stu) => {
                  const existingMark = state.data.marks.find(
                    (m) =>
                      m.studentId === stu.id &&
                      m.examId === selectedExam.id &&
                      m.subjectId === selectedSubject.id
                  );
                  return `
                    <tr>
                      <td class="mono-code">${escapeHtml(stu.rollNo)}</td>
                      <td class="mono-code">${escapeHtml(stu.admissionNo)}</td>
                      <td><strong>${escapeHtml(stu.fullName)}</strong></td>
                      <td class="num-col">${maxMarks} / ${passMarks}</td>
                      <td>
                        <input
                          type="number"
                          class="form-input mono-code"
                          style="width:130px;"
                          min="0"
                          max="${maxMarks}"
                          step="0.5"
                          name="mark_${escapeHtml(stu.id)}"
                          aria-label="Obtained marks for ${escapeHtml(stu.fullName)}"
                          value="${existingMark ? existingMark.obtainedMarks : ''}"
                          placeholder="0 – ${maxMarks}"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          class="form-input"
                          style="width:100%;"
                          name="remark_${escapeHtml(stu.id)}"
                          aria-label="Remarks for ${escapeHtml(stu.fullName)}"
                          value="${existingMark ? escapeHtml(existingMark.remarks || '') : ''}"
                          placeholder="Optional teacher note"
                        />
                      </td>
                      <td>
                        ${
                          existingMark
                            ? `<span class="status-indicator ${existingMark.passed ? 'status-pass' : 'status-fail'}">${existingMark.passed ? '▲ PASS' : '■ FAIL'} · ${escapeHtml(existingMark.grade)} (${existingMark.percentage}%)</span>`
                            : `<span style="font-size:0.8rem;color:var(--text-muted);">Not entered</span>`
                        }
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:1.25rem;display:flex;justify-content:flex-end;">
          <button type="submit" class="btn btn-primary" ${selectedExam.status === 'locked' ? 'disabled' : ''}>
            ${selectedExam.status === 'locked' ? 'Examination Locked by Admin' : 'Validate & Save Marks'}
          </button>
        </div>
      </form>
    `
    }
  `;
}

function renderTeacherStudentResults(teacher) {
  const search = state.marksSearch.trim().toLowerCase();
  const authorizedMarks = state.data.marks.filter((m) => {
    const inAssignedClass = teacher.assignedClassIds.includes(m.classId);
    const inAssignedSection = teacher.assignedSectionIds.includes(m.sectionId);
    if (!inAssignedClass || !inAssignedSection) return false;
    if (state.marksClassFilter !== 'all' && m.classId !== state.marksClassFilter) return false;
    if (state.marksSectionFilter !== 'all' && m.sectionId !== state.marksSectionFilter) return false;
    if (state.marksSubjectFilter !== 'all' && m.subjectId !== state.marksSubjectFilter) return false;
    if (search) {
      const hay = `${m.studentName} ${m.admissionNo} ${m.rollNo}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const assignedClasses = state.data.classes.filter((c) => teacher.assignedClassIds.includes(c.id));
  const assignedSections = state.data.sections.filter((s) => teacher.assignedSectionIds.includes(s.id));
  const assignedSubjects = state.data.subjects.filter((sub) => teacher.assignedSubjectIds.includes(sub.id));

  return `
    <div class="view-header-row">
      <div>
        <h1>Authorized Student Results</h1>
        <p>Filter and review examination results for scholars within your assigned classes and sections.</p>
      </div>
    </div>

    <div class="filter-toolbar">
      <div class="filter-controls-group">
        <input
          type="search"
          id="marks-search-input"
          class="form-input"
          style="min-width:220px;flex:1;"
          placeholder="Search student name, admission no, roll no..."
          value="${escapeHtml(state.marksSearch)}"
          aria-label="Search Student Results"
        />
        <select id="marks-class-filter" class="form-select" aria-label="Filter by Assigned Class">
          <option value="all">All Assigned Classes</option>
          ${assignedClasses
            .map((c) => `<option value="${escapeHtml(c.id)}" ${state.marksClassFilter === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
            .join('')}
        </select>
        <select id="marks-section-filter" class="form-select" aria-label="Filter by Assigned Section">
          <option value="all">All Assigned Sections</option>
          ${assignedSections
            .map((s) => `<option value="${escapeHtml(s.id)}" ${state.marksSectionFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
            .join('')}
        </select>
        <select id="marks-subject-filter" class="form-select" aria-label="Filter by Assigned Subject">
          <option value="all">All Subjects</option>
          ${assignedSubjects
            .map((sub) => `<option value="${escapeHtml(sub.id)}" ${state.marksSubjectFilter === sub.id ? 'selected' : ''}>${escapeHtml(sub.name)}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Admission No</th>
            <th>Roll No</th>
            <th>Student Name</th>
            <th>Subject</th>
            <th class="num-col">Marks</th>
            <th class="num-col">Percentage</th>
            <th class="num-col">Grade</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${authorizedMarks
            .map(
              (m) => `
            <tr>
              <td class="mono-code">${escapeHtml(m.admissionNo)}</td>
              <td class="mono-code">${escapeHtml(m.rollNo)}</td>
              <td><strong>${escapeHtml(m.studentName)}</strong></td>
              <td>${escapeHtml(m.subjectName)}</td>
              <td class="num-col">${m.obtainedMarks} / ${m.maxMarks}</td>
              <td class="num-col">${m.percentage}%</td>
              <td class="num-col"><strong>${escapeHtml(m.grade)}</strong></td>
              <td>
                <span class="status-indicator ${m.passed ? 'status-pass' : 'status-fail'}">
                  ${m.passed ? '▲ PASS' : '■ FAIL'}
                </span>
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// 12. STUDENT DASHBOARD & OFFICIAL MARKSHEET RENDERER (SECTION 8 & 11)
// ============================================================================
function renderStudentWorkspace() {
  const student = state.data.students.find((s) => s.userId === state.currentUser.uid);
  if (!student) {
    return `<div class="empty-state-box"><h3>Student record not found</h3><p>Please contact the Campus Registrar.</p></div>`;
  }

  switch (state.activeNav) {
    case 'overview':
      return renderStudentMarksheetView(student);
    case 'history':
      return renderStudentResultHistory(student);
    case 'profile':
      return renderUniversalProfileView();
    default:
      return renderStudentMarksheetView(student);
  }
}

function renderOfficialMarksheetCard(student, exam, studentExamMarks) {
  const school = state.data.schoolSettings;
  const gradingScale = state.data.appSettings.gradingScaleJson || DEFAULT_GRADING_SCALE;
  const summary = calculateAggregateMarksheet(studentExamMarks, gradingScale);

  return `
    <div class="marksheet-paper" id="printable-marksheet">
      <div class="marksheet-header">
        <div class="marksheet-school-brand">
          <div class="marksheet-logo-box">
            ${
              getSafeLogoSrc(school.logoUrl, '')
                ? `<img src="${escapeHtml(getSafeLogoSrc(school.logoUrl, ASSETS.campusLogo))}" alt="${escapeHtml(school.name)} Logo" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
                : escapeHtml(state.data.appSettings.logoText || 'DH')
            }
          </div>
          <div>
            <h2>${escapeHtml(school.name)}</h2>
            <p>${escapeHtml(school.campusSubtitle)}</p>
            <p style="font-size:0.78rem;margin-top:0.15rem;">${escapeHtml(school.address)} · ${escapeHtml(school.phone)}</p>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="mono-code" style="font-size:0.78rem;font-weight:700;color:#C84312;">OFFICIAL STATEMENT OF MARKS</div>
          <div style="font-family:var(--font-display);font-weight:700;font-size:1.05rem;color:#111111;">
            ${escapeHtml(exam ? exam.name : 'Cumulative Academic Transcript')}
          </div>
          <div class="mono-code" style="font-size:0.78rem;color:#5A554C;">Session ${escapeHtml(school.academicYear)}</div>
        </div>
      </div>

      <!-- Student Details Grid -->
      <div class="marksheet-student-grid">
        <div>
          <span class="marksheet-field-label">Student Full Name</span>
          <span class="marksheet-field-value">${escapeHtml(student.fullName)}</span>
        </div>
        <div>
          <span class="marksheet-field-label">Admission Number</span>
          <span class="marksheet-field-value mono-code">${escapeHtml(student.admissionNo)}</span>
        </div>
        <div>
          <span class="marksheet-field-label">Roll Number</span>
          <span class="marksheet-field-value mono-code">${escapeHtml(student.rollNo)}</span>
        </div>
        <div>
          <span class="marksheet-field-label">Class</span>
          <span class="marksheet-field-value">${escapeHtml(student.className)}</span>
        </div>
        <div>
          <span class="marksheet-field-label">Section</span>
          <span class="marksheet-field-value">${escapeHtml(student.sectionName)}</span>
        </div>
        <div>
          <span class="marksheet-field-label">Examination</span>
          <span class="marksheet-field-value">${escapeHtml(exam ? exam.name : 'All Published Exams')}</span>
        </div>
      </div>

      <!-- Subject-wise Marks Table -->
      <table class="marksheet-table">
        <thead>
          <tr>
            <th>Subject Name</th>
            <th class="num-col">Maximum Marks</th>
            <th class="num-col">Pass Marks</th>
            <th class="num-col">Obtained Marks</th>
            <th class="num-col">Percentage</th>
            <th class="num-col">Grade</th>
            <th>Subject Status</th>
          </tr>
        </thead>
        <tbody>
          ${
            studentExamMarks.length === 0
              ? `<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:#5A554C;">No subject marks recorded for this examination yet.</td></tr>`
              : studentExamMarks
                  .map(
                    (m) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(m.subjectName)}</strong>
                      ${m.remarks ? `<div style="font-size:0.76rem;color:#5A554C;">Note: ${escapeHtml(m.remarks)}</div>` : ''}
                    </td>
                    <td class="num-col">${m.maxMarks}</td>
                    <td class="num-col">${m.passMarks}</td>
                    <td class="num-col"><strong>${m.obtainedMarks}</strong></td>
                    <td class="num-col">${m.percentage}%</td>
                    <td class="num-col"><strong>${escapeHtml(m.grade)}</strong></td>
                    <td class="mono-code" style="font-weight:700;color:${m.passed ? '#15803D' : '#B91C1C'};">
                      ${m.passed ? '▲ PASS' : '■ FAIL'}
                    </td>
                  </tr>
                `
                  )
                  .join('')
          }
        </tbody>
      </table>

      <!-- Summary Strip -->
      <div class="marksheet-summary-strip">
        <div class="marksheet-summary-item">
          <span>Total Marks</span>
          <strong>${summary.totalMaxMarks}</strong>
        </div>
        <div class="marksheet-summary-item">
          <span>Obtained Marks</span>
          <strong>${summary.totalObtainedMarks}</strong>
        </div>
        <div class="marksheet-summary-item">
          <span>Percentage</span>
          <strong>${summary.percentage}%</strong>
        </div>
        <div class="marksheet-summary-item">
          <span>Final Grade (GPA)</span>
          <strong>${escapeHtml(summary.grade)} (${Number(summary.gpa).toFixed(1)})</strong>
        </div>
        <div class="marksheet-summary-item">
          <span>Result Status</span>
          <strong style="color:${summary.passed ? '#15803D' : '#B91C1C'};">
            ${summary.passed ? '▲ PASSED' : '■ FAILED'}
          </strong>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:2.25rem;padding-top:1rem;border-top:1px dashed rgba(17,17,17,0.2);font-size:0.78rem;color:#5A554C;">
        <div>Controller of Examinations · ${escapeHtml(school.name)}</div>
        <div>Principal: <strong>${escapeHtml(school.principalName || 'Dean of Academics')}</strong></div>
      </div>
    </div>
  `;
}

function renderStudentMarksheetView(student) {
  const exams = state.data.examinations.filter((e) => e.classId === student.classId);
  const activeExamId = state.selectedStudentExamId || exams[0]?.id || state.data.examinations[0]?.id || '';
  const selectedExam = state.data.examinations.find((e) => e.id === activeExamId);
  const myMarks = state.data.marks.filter(
    (m) => m.studentId === student.id && (!selectedExam || m.examId === selectedExam.id)
  );

  return `
    <div class="view-header-row no-print">
      <div>
        <h1>Official Academic Marksheet</h1>
        <p>Admission No: <span class="mono-code">${escapeHtml(student.admissionNo)}</span> · Roll No: <span class="mono-code">${escapeHtml(student.rollNo)}</span> · ${escapeHtml(student.className)} (${escapeHtml(student.sectionName)})</p>
      </div>
      <div style="display:flex;gap:0.75rem;align-items:center;">
        <label for="stu-exam-selector" style="font-size:0.84rem;color:var(--text-muted);">Examination:</label>
        <select id="stu-exam-selector" class="form-select">
          ${(exams.length ? exams : state.data.examinations)
            .map((e) => `<option value="${escapeHtml(e.id)}" ${e.id === activeExamId ? 'selected' : ''}>${escapeHtml(e.name)}</option>`)
            .join('')}
        </select>
        <button type="button" class="btn btn-primary" id="btn-print-marksheet">Print / Save PDF</button>
      </div>
    </div>

    ${renderOfficialMarksheetCard(student, selectedExam, myMarks)}
  `;
}

function renderStudentResultHistory(student) {
  const myMarks = state.data.marks.filter((m) => m.studentId === student.id);
  const summary = calculateAggregateMarksheet(myMarks, state.data.appSettings.gradingScaleJson);

  return `
    <div class="view-header-row">
      <div>
        <h1>Complete Examination &amp; Subject Result History</h1>
        <p>Cumulative Percentage: <strong class="mono-code">${summary.percentage}%</strong> · Overall Grade: <strong class="mono-code">${escapeHtml(summary.grade)}</strong></p>
      </div>
    </div>

    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Examination Name</th>
            <th>Subject</th>
            <th class="num-col">Maximum Marks</th>
            <th class="num-col">Pass Marks</th>
            <th class="num-col">Obtained Marks</th>
            <th class="num-col">Percentage</th>
            <th class="num-col">Grade</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${myMarks
            .map(
              (m) => `
            <tr>
              <td>${escapeHtml(m.examName)}</td>
              <td><strong>${escapeHtml(m.subjectName)}</strong></td>
              <td class="num-col">${m.maxMarks}</td>
              <td class="num-col">${m.passMarks}</td>
              <td class="num-col"><strong>${m.obtainedMarks}</strong></td>
              <td class="num-col">${m.percentage}%</td>
              <td class="num-col"><strong>${escapeHtml(m.grade)}</strong></td>
              <td>
                <span class="status-indicator ${m.passed ? 'status-pass' : 'status-fail'}">
                  ${m.passed ? '▲ PASS' : '■ FAIL'}
                </span>
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// 13. UNIVERSAL PROFILE & PASSWORD MANAGEMENT (SECTION 9 — ALL THREE ROLES)
// ============================================================================
function renderUniversalProfileView() {
  const user = state.currentUser;
  const priv = state.data.privateProfiles[user.uid] || {
    uid: user.uid,
    phone: '',
    address: '',
    guardianName: '',
    dateOfBirth: '',
    bloodGroup: '',
    bio: ''
  };
  const studentRecord = user.role === 'student' ? state.data.students.find((s) => s.userId === user.uid) : null;
  const teacherRecord = user.role === 'teacher' ? state.data.teachers.find((t) => t.userId === user.uid) : null;

  return `
    <div class="view-header-row">
      <div>
        <h1>Personal Profile &amp; Security Credentials</h1>
        <p>Manage your account username, password, profile picture, and isolated personal contact details.</p>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:1.5rem;align-items:start;">
      <div class="surface-panel">
        <h3>Profile Details (${escapeHtml(user.role.toUpperCase())})</h3>
        <p class="panel-sub">Protected academic fields are read-only for non-administrators.</p>

        ${
          studentRecord
            ? `
          <div style="padding:1rem;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);margin-bottom:1.25rem;font-size:0.84rem;">
            <div style="color:var(--text-muted);margin-bottom:0.35rem;">Assigned Institutional Identifiers (Read-Only):</div>
            <div class="mono-code">
              Admission No: <strong>${escapeHtml(studentRecord.admissionNo)}</strong> ·
              Roll No: <strong>${escapeHtml(studentRecord.rollNo)}</strong> ·
              ${escapeHtml(studentRecord.className)} (${escapeHtml(studentRecord.sectionName)})
            </div>
          </div>
        `
            : ''
        }

        ${
          teacherRecord
            ? `
          <div style="padding:1rem;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);margin-bottom:1.25rem;font-size:0.84rem;">
            <div style="color:var(--text-muted);margin-bottom:0.35rem;">Faculty Assignment Identifiers (Read-Only):</div>
            <div class="mono-code">
              Employee ID: <strong>${escapeHtml(teacherRecord.employeeId)}</strong> ·
              ${escapeHtml(teacherRecord.designation)}
            </div>
          </div>
        `
            : ''
        }

        <form id="form-update-own-profile">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="prof-fullname-input">Full Name</label>
              <input type="text" id="prof-fullname-input" class="form-input" value="${escapeHtml(user.fullName)}" required />
            </div>
            <div class="form-field">
              <label for="prof-username-input">Login Username</label>
              <input type="text" id="prof-username-input" class="form-input mono-code" value="${escapeHtml(user.username)}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="prof-phone-input">Phone Number</label>
              <input type="text" id="prof-phone-input" class="form-input mono-code" value="${escapeHtml(priv.phone)}" required />
            </div>
            <div class="form-field">
              <label for="prof-blood-input">Blood Group</label>
              <input type="text" id="prof-blood-input" class="form-input" value="${escapeHtml(priv.bloodGroup || '')}" />
            </div>
          </div>

          <div class="form-field">
            <label for="prof-address-input">Residential Address</label>
            <input type="text" id="prof-address-input" class="form-input" value="${escapeHtml(priv.address)}" required />
          </div>

          <div class="form-field">
            <label for="prof-avatar-input">Profile Picture URL (or Upload Image Below)</label>
            <input type="text" id="prof-avatar-input" class="form-input" value="${escapeHtml(user.avatarUrl || '')}" placeholder="https://... or upload below" />
          </div>

          <div class="form-field">
            <label for="prof-avatar-file">Upload Profile Image (Optimized for Cloud Sync)</label>
            <input type="file" id="prof-avatar-file" accept="image/*" class="form-input" />
          </div>

          <div class="form-field">
            <label for="prof-bio-input">Additional Personal Details / Academic Bio</label>
            <textarea id="prof-bio-input" class="form-textarea">${escapeHtml(priv.bio || '')}</textarea>
          </div>

          <div style="display:flex;justify-content:flex-end;">
            <button type="submit" class="btn btn-primary">Save Profile Changes</button>
          </div>
        </form>
      </div>

      <div class="surface-panel">
        <h3>Change Account Password</h3>
        <p class="panel-sub">Updates your salted SHA-256 authentication credential across all devices.</p>
        <form id="form-change-own-password">
          <div class="form-field">
            <label for="pwd-current-input">Current Password</label>
            <input type="password" id="pwd-current-input" class="form-input" required />
          </div>
          <div class="form-field">
            <label for="pwd-new-input">New Password (min 6 characters)</label>
            <input type="password" id="pwd-new-input" class="form-input" minlength="6" required />
          </div>
          <div class="form-field">
            <label for="pwd-confirm-input">Confirm New Password</label>
            <input type="password" id="pwd-confirm-input" class="form-input" minlength="6" required />
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
            <button type="submit" class="btn btn-primary">Update Password</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ============================================================================
// 14. ADMIN CRUD MODALS (STUDENT, TEACHER, CLASS, SECTION, SUBJECT, EXAM, MARK)
// ============================================================================
function openStudentFormModal(existingStu = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const { classes, sections, privateProfiles } = state.data;
  const isEdit = Boolean(existingStu);
  const priv = existingStu ? privateProfiles[existingStu.userId] || {} : {};

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="stu-modal-title">
      <div class="modal-dialog">
        <div class="modal-header">
          <h2 id="stu-modal-title">${isEdit ? 'Edit Scholar Record' : 'Enroll New Scholar'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-student-form">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-stu-name">Full Name</label>
              <input type="text" id="m-stu-name" class="form-input" value="${escapeHtml(existingStu?.fullName || '')}" required />
            </div>
            <div class="form-field">
              <label for="m-stu-adm">Unique Admission Number</label>
              <input type="text" id="m-stu-adm" class="form-input mono-code" value="${escapeHtml(existingStu?.admissionNo || `DHBC-2026-00${state.data.students.length + 1}`)}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-stu-class">Assigned Class</label>
              <select id="m-stu-class" class="form-select" required>
                ${classes
                  .map((c) => `<option value="${escapeHtml(c.id)}" ${existingStu?.classId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="form-field">
              <label for="m-stu-section">Assigned Section</label>
              <select id="m-stu-section" class="form-select" required>
                ${sections
                  .map((s) => `<option value="${escapeHtml(s.id)}" ${existingStu?.sectionId === s.id ? 'selected' : ''}>${escapeHtml(s.name)} (${escapeHtml(s.className)})</option>`)
                  .join('')}
              </select>
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-stu-roll">Roll Number (Unique in Class &amp; Section)</label>
              <input type="text" id="m-stu-roll" class="form-input mono-code" value="${escapeHtml(existingStu?.rollNo || '01')}" required />
            </div>
            <div class="form-field">
              <label for="m-stu-username">Student Login Username</label>
              <input type="text" id="m-stu-username" class="form-input mono-code" value="${escapeHtml(existingStu?.username || '')}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-stu-password">${isEdit ? 'Reset Password (leave blank to keep)' : 'Initial Password'}</label>
              <input type="password" id="m-stu-password" class="form-input" ${isEdit ? '' : 'value="Student@123" required'} placeholder="${isEdit ? 'Unchanged if empty' : 'Enter password'}" />
            </div>
            <div class="form-field">
              <label for="m-stu-phone">Guardian Phone Number</label>
              <input type="text" id="m-stu-phone" class="form-input mono-code" value="${escapeHtml(priv.phone || '+91 ')}" required />
            </div>
          </div>

          <div class="form-field">
            <label for="m-stu-address">Residential Address</label>
            <input type="text" id="m-stu-address" class="form-input" value="${escapeHtml(priv.address || 'West Bengal')}" required />
          </div>

          <div id="m-stu-error" style="color:var(--status-fail);font-size:0.84rem;margin-bottom:0.5rem;"></div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Student & Login Account'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-student-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = document.getElementById('m-stu-name').value.trim();
    const admissionNo = document.getElementById('m-stu-adm').value.trim();
    const classId = document.getElementById('m-stu-class').value;
    const sectionId = document.getElementById('m-stu-section').value;
    const rollNo = document.getElementById('m-stu-roll').value.trim();
    const username = normalizeUsername(document.getElementById('m-stu-username').value);
    const password = document.getElementById('m-stu-password').value;
    const phone = document.getElementById('m-stu-phone').value.trim();
    const address = document.getElementById('m-stu-address').value.trim();
    const errEl = document.getElementById('m-stu-error');

    const uniqueness = validateStudentUniqueness(
      { id: existingStu?.id, admissionNo, rollNo, classId, sectionId },
      state.data.students
    );
    if (!uniqueness.valid) {
      errEl.textContent = uniqueness.error;
      return;
    }

    const usernameClash = state.data.users.find(
      (u) => normalizeUsername(u.username) === username && u.uid !== existingStu?.userId
    );
    if (usernameClash) {
      errEl.textContent = `Username "${username}" is already taken.`;
      return;
    }

    const clsObj = classes.find((c) => c.id === classId);
    const secObj = sections.find((s) => s.id === sectionId);
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingStu.fullName = fullName;
      existingStu.admissionNo = admissionNo;
      existingStu.classId = classId;
      existingStu.className = clsObj?.name || '';
      existingStu.sectionId = sectionId;
      existingStu.sectionName = secObj?.name || '';
      existingStu.rollNo = rollNo;
      existingStu.username = username;
      existingStu.updatedAt = nowIso;

      const userAccount = state.data.users.find((u) => u.uid === existingStu.userId);
      if (userAccount) {
        userAccount.fullName = fullName;
        userAccount.username = username;
        if (password && password.length >= 6) {
          userAccount.passwordHash = await hashPasswordSha256(password, username);
        }
        userAccount.updatedAt = nowIso;
        await syncDocumentToFirestore('users', userAccount.uid, userAccount, OperationType.UPDATE);
      }

      const privProfile = {
        ...(state.data.privateProfiles[existingStu.userId] || {}),
        uid: existingStu.userId,
        phone,
        address,
        updatedAt: nowIso
      };
      state.data.privateProfiles[existingStu.userId] = privProfile;
      await syncDocumentToFirestore(`users/${existingStu.userId}/private`, 'info', privProfile, OperationType.WRITE);

      await syncDocumentToFirestore('students', existingStu.id, existingStu, OperationType.UPDATE);
      await recordActivity(`Updated student record for ${fullName} (${admissionNo})`, 'Student');
      showToast(`Student "${fullName}" updated.`, 'success');
    } else {
      const stuId = `stu_${Date.now()}`;
      const usrId = `usr_${Date.now()}`;
      const pwdHash = await hashPasswordSha256(password || 'Student@123', username);

      const newUser = {
        uid: usrId,
        username,
        role: 'student',
        fullName,
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: stuId,
        passwordHash: pwdHash,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      const newStudent = {
        id: stuId,
        userId: usrId,
        admissionNo,
        rollNo,
        fullName,
        username,
        classId,
        className: clsObj?.name || '',
        sectionId,
        sectionName: secObj?.name || '',
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      };

      const privProfile = {
        uid: usrId,
        phone,
        address,
        updatedAt: nowIso
      };

      state.data.users.push(newUser);
      state.data.students.push(newStudent);
      state.data.privateProfiles[usrId] = privProfile;

      await syncDocumentToFirestore('users', usrId, newUser, OperationType.CREATE);
      await syncDocumentToFirestore(`users/${usrId}/private`, 'info', privProfile, OperationType.CREATE);
      await syncDocumentToFirestore('students', stuId, newStudent, OperationType.CREATE);
      await recordActivity(`Enrolled new student ${fullName} (${admissionNo})`, 'Student');
      showToast(`Enrolled "${fullName}" with login @${username}`, 'success');
    }

    closeModal();
    renderApp();
  });
}

function openTeacherFormModal(existingTeacher = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const { classes, sections, subjects } = state.data;
  const isEdit = Boolean(existingTeacher);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="tch-modal-title">
      <div class="modal-dialog">
        <div class="modal-header">
          <h2 id="tch-modal-title">${isEdit ? 'Edit Faculty & Academic Assignments' : 'Add New Faculty Member'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-teacher-form">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-tch-name">Full Name</label>
              <input type="text" id="m-tch-name" class="form-input" value="${escapeHtml(existingTeacher?.fullName || '')}" required />
            </div>
            <div class="form-field">
              <label for="m-tch-emp">Employee ID</label>
              <input type="text" id="m-tch-emp" class="form-input mono-code" value="${escapeHtml(existingTeacher?.employeeId || `DHBC-FAC-${101 + state.data.teachers.length}`)}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-tch-desig">Academic Designation</label>
              <input type="text" id="m-tch-desig" class="form-input" value="${escapeHtml(existingTeacher?.designation || 'Senior Lecturer')}" required />
            </div>
            <div class="form-field">
              <label for="m-tch-username">Login Username</label>
              <input type="text" id="m-tch-username" class="form-input mono-code" value="${escapeHtml(existingTeacher?.username || '')}" required />
            </div>
          </div>

          <div class="form-field">
            <label for="m-tch-password">${isEdit ? 'Reset Password (leave blank to keep)' : 'Initial Password'}</label>
            <input type="password" id="m-tch-password" class="form-input" ${isEdit ? '' : 'value="Teacher@123" required'} />
          </div>

          <div class="form-field">
            <label>Assign Authorized Classes</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;padding:0.65rem;background:var(--bg-primary);border-radius:var(--radius-sm);">
              ${classes
                .map(
                  (c) => `
                <label style="display:inline-flex;align-items:center;gap:0.4rem;font-weight:400;">
                  <input type="checkbox" name="tch_cls" value="${escapeHtml(c.id)}" ${existingTeacher?.assignedClassIds?.includes(c.id) ? 'checked' : ''} />
                  ${escapeHtml(c.name)}
                </label>
              `
                )
                .join('')}
            </div>
          </div>

          <div class="form-field">
            <label>Assign Authorized Sections</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;padding:0.65rem;background:var(--bg-primary);border-radius:var(--radius-sm);">
              ${sections
                .map(
                  (s) => `
                <label style="display:inline-flex;align-items:center;gap:0.4rem;font-weight:400;">
                  <input type="checkbox" name="tch_sec" value="${escapeHtml(s.id)}" ${existingTeacher?.assignedSectionIds?.includes(s.id) ? 'checked' : ''} />
                  ${escapeHtml(s.name)}
                </label>
              `
                )
                .join('')}
            </div>
          </div>

          <div class="form-field">
            <label>Assign Authorized Subjects</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;padding:0.65rem;background:var(--bg-primary);border-radius:var(--radius-sm);">
              ${subjects
                .map(
                  (sub) => `
                <label style="display:inline-flex;align-items:center;gap:0.4rem;font-weight:400;">
                  <input type="checkbox" name="tch_sub" value="${escapeHtml(sub.id)}" ${existingTeacher?.assignedSubjectIds?.includes(sub.id) ? 'checked' : ''} />
                  ${escapeHtml(sub.name)}
                </label>
              `
                )
                .join('')}
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Faculty Assignments' : 'Create Faculty Account'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-teacher-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fullName = document.getElementById('m-tch-name').value.trim();
    const employeeId = document.getElementById('m-tch-emp').value.trim();
    const designation = document.getElementById('m-tch-desig').value.trim();
    const username = normalizeUsername(document.getElementById('m-tch-username').value);
    const password = document.getElementById('m-tch-password').value;

    const assignedClassIds = Array.from(document.querySelectorAll('input[name="tch_cls"]:checked')).map((el) => el.value);
    const assignedSectionIds = Array.from(document.querySelectorAll('input[name="tch_sec"]:checked')).map((el) => el.value);
    const assignedSubjectIds = Array.from(document.querySelectorAll('input[name="tch_sub"]:checked')).map((el) => el.value);
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingTeacher.fullName = fullName;
      existingTeacher.employeeId = employeeId;
      existingTeacher.designation = designation;
      existingTeacher.username = username;
      existingTeacher.assignedClassIds = assignedClassIds;
      existingTeacher.assignedSectionIds = assignedSectionIds;
      existingTeacher.assignedSubjectIds = assignedSubjectIds;
      existingTeacher.updatedAt = nowIso;

      const userAcc = state.data.users.find((u) => u.uid === existingTeacher.userId);
      if (userAcc) {
        userAcc.fullName = fullName;
        userAcc.username = username;
        if (password && password.length >= 6) {
          userAcc.passwordHash = await hashPasswordSha256(password, username);
        }
        userAcc.updatedAt = nowIso;
        await syncDocumentToFirestore('users', userAcc.uid, userAcc, OperationType.UPDATE);
      }
      await syncDocumentToFirestore('teachers', existingTeacher.id, existingTeacher, OperationType.UPDATE);
      await recordActivity(`Updated faculty assignments for ${fullName}`, 'Teacher');
      showToast(`Faculty "${fullName}" updated.`, 'success');
    } else {
      const tchId = `tch_${Date.now()}`;
      const usrId = `usr_${Date.now()}`;
      const pwdHash = await hashPasswordSha256(password || 'Teacher@123', username);

      const newUser = {
        uid: usrId,
        username,
        role: 'teacher',
        fullName,
        avatarUrl: '',
        mustChangePassword: false,
        linkedEntityId: tchId,
        passwordHash: pwdHash,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      const newTeacher = {
        id: tchId,
        userId: usrId,
        employeeId,
        fullName,
        username,
        designation,
        assignedClassIds,
        assignedSectionIds,
        assignedSubjectIds,
        avatarUrl: '',
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso
      };

      state.data.users.push(newUser);
      state.data.teachers.push(newTeacher);
      await syncDocumentToFirestore('users', usrId, newUser, OperationType.CREATE);
      await syncDocumentToFirestore('teachers', tchId, newTeacher, OperationType.CREATE);
      await recordActivity(`Added faculty member ${fullName} (@${username})`, 'Teacher');
      showToast(`Added faculty "${fullName}"`, 'success');
    }

    closeModal();
    renderApp();
  });
}

function openClassFormModal(existingClass = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const isEdit = Boolean(existingClass);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cls-modal-title">
      <div class="modal-dialog" style="max-width:500px;">
        <div class="modal-header">
          <h2 id="cls-modal-title">${isEdit ? 'Edit Academic Class' : 'Create Academic Class'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-class-form">
          <div class="form-field">
            <label for="m-cls-name">Class Name</label>
            <input type="text" id="m-cls-name" class="form-input" value="${escapeHtml(existingClass?.name || '')}" placeholder="e.g. Sanawiyya Year I (Class IX)" required />
          </div>
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-cls-code">Class Code</label>
              <input type="text" id="m-cls-code" class="form-input mono-code" value="${escapeHtml(existingClass?.code || 'SNW-09')}" required />
            </div>
            <div class="form-field">
              <label for="m-cls-cap">Max Student Capacity</label>
              <input type="number" id="m-cls-cap" class="form-input mono-code" min="1" max="1000" value="${existingClass?.capacity || 60}" required />
            </div>
          </div>
          <div class="form-field">
            <label for="m-cls-desc">Cohort Description</label>
            <input type="text" id="m-cls-desc" class="form-input" value="${escapeHtml(existingClass?.description || '')}" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Class' : 'Create Class'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-class-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('m-cls-name').value.trim();
    const code = document.getElementById('m-cls-code').value.trim();
    const capacity = Number(document.getElementById('m-cls-cap').value) || 60;
    const description = document.getElementById('m-cls-desc').value.trim();
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingClass.name = name;
      existingClass.code = code;
      existingClass.capacity = capacity;
      existingClass.description = description;
      existingClass.updatedAt = nowIso;
      await syncDocumentToFirestore('classes', existingClass.id, existingClass, OperationType.UPDATE);
      showToast(`Class "${name}" updated.`, 'success');
    } else {
      const newCls = {
        id: `cls_${Date.now()}`,
        name,
        code,
        academicYear: state.data.schoolSettings.academicYear,
        capacity,
        description,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.data.classes.push(newCls);
      await syncDocumentToFirestore('classes', newCls.id, newCls, OperationType.CREATE);
      await recordActivity(`Created class ${name} (${code})`, 'Class');
      showToast(`Created class "${name}".`, 'success');
    }
    closeModal();
    renderApp();
  });
}

function openSectionFormModal(existingSec = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const isEdit = Boolean(existingSec);
  const { classes } = state.data;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sec-modal-title">
      <div class="modal-dialog" style="max-width:500px;">
        <div class="modal-header">
          <h2 id="sec-modal-title">${isEdit ? 'Edit Class Section' : 'Create Class Section'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-section-form">
          <div class="form-field">
            <label for="m-sec-name">Section Name</label>
            <input type="text" id="m-sec-name" class="form-input" value="${escapeHtml(existingSec?.name || '')}" placeholder="e.g. Section Al-Razi (C)" required />
          </div>
          <div class="form-field">
            <label for="m-sec-class">Assign to Class</label>
            <select id="m-sec-class" class="form-select" required>
              ${classes
                .map((c) => `<option value="${escapeHtml(c.id)}" ${existingSec?.classId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-sec-room">Lecture Hall / Room No</label>
              <input type="text" id="m-sec-room" class="form-input mono-code" value="${escapeHtml(existingSec?.roomNo || 'Hall 204')}" required />
            </div>
            <div class="form-field">
              <label for="m-sec-cap">Section Capacity</label>
              <input type="number" id="m-sec-cap" class="form-input mono-code" min="1" max="500" value="${existingSec?.capacity || 35}" required />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Section' : 'Create Section'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-section-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('m-sec-name').value.trim();
    const classId = document.getElementById('m-sec-class').value;
    const roomNo = document.getElementById('m-sec-room').value.trim();
    const capacity = Number(document.getElementById('m-sec-cap').value) || 35;
    const clsObj = classes.find((c) => c.id === classId);
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingSec.name = name;
      existingSec.classId = classId;
      existingSec.className = clsObj?.name || '';
      existingSec.roomNo = roomNo;
      existingSec.capacity = capacity;
      existingSec.updatedAt = nowIso;
      await syncDocumentToFirestore('sections', existingSec.id, existingSec, OperationType.UPDATE);
      showToast(`Section "${name}" updated.`, 'success');
    } else {
      const newSec = {
        id: `sec_${Date.now()}`,
        name,
        classId,
        className: clsObj?.name || '',
        roomNo,
        capacity,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.data.sections.push(newSec);
      await syncDocumentToFirestore('sections', newSec.id, newSec, OperationType.CREATE);
      await recordActivity(`Created section ${name} for ${clsObj?.name}`, 'Section');
      showToast(`Created section "${name}".`, 'success');
    }
    closeModal();
    renderApp();
  });
}

function openSubjectFormModal(existingSub = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const isEdit = Boolean(existingSub);
  const { classes, teachers } = state.data;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sub-modal-title">
      <div class="modal-dialog" style="max-width:520px;">
        <div class="modal-header">
          <h2 id="sub-modal-title">${isEdit ? 'Edit Academic Subject' : 'Add Academic Subject'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-subject-form">
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-sub-name">Subject Name</label>
              <input type="text" id="m-sub-name" class="form-input" value="${escapeHtml(existingSub?.name || '')}" placeholder="e.g. Islamic Jurisprudence" required />
            </div>
            <div class="form-field">
              <label for="m-sub-code">Subject Code</label>
              <input type="text" id="m-sub-code" class="form-input mono-code" value="${escapeHtml(existingSub?.code || 'FQH-104')}" required />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-sub-class">Assign to Class</label>
              <select id="m-sub-class" class="form-select" required>
                ${classes
                  .map((c) => `<option value="${escapeHtml(c.id)}" ${existingSub?.classId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="form-field">
              <label for="m-sub-teacher">Assign Faculty</label>
              <select id="m-sub-teacher" class="form-select" required>
                ${teachers
                  .map((t) => `<option value="${escapeHtml(t.id)}" ${existingSub?.teacherId === t.id ? 'selected' : ''}>${escapeHtml(t.fullName)}</option>`)
                  .join('')}
              </select>
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-sub-max">Maximum Marks</label>
              <input type="number" id="m-sub-max" class="form-input mono-code" min="1" max="1000" value="${existingSub?.maxMarks || 100}" required />
            </div>
            <div class="form-field">
              <label for="m-sub-pass">Pass Marks</label>
              <input type="number" id="m-sub-pass" class="form-input mono-code" min="0" max="1000" value="${existingSub?.passMarks || 40}" required />
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Subject' : 'Add Subject'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-subject-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('m-sub-name').value.trim();
    const code = document.getElementById('m-sub-code').value.trim();
    const classId = document.getElementById('m-sub-class').value;
    const teacherId = document.getElementById('m-sub-teacher').value;
    const maxMarks = Number(document.getElementById('m-sub-max').value) || 100;
    const passMarks = Number(document.getElementById('m-sub-pass').value) || 40;

    const clsObj = classes.find((c) => c.id === classId);
    const tchObj = teachers.find((t) => t.id === teacherId);
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingSub.name = name;
      existingSub.code = code;
      existingSub.classId = classId;
      existingSub.className = clsObj?.name || '';
      existingSub.teacherId = teacherId;
      existingSub.teacherName = tchObj?.fullName || '';
      existingSub.maxMarks = maxMarks;
      existingSub.passMarks = passMarks;
      existingSub.updatedAt = nowIso;
      await syncDocumentToFirestore('subjects', existingSub.id, existingSub, OperationType.UPDATE);
      showToast(`Subject "${name}" updated.`, 'success');
    } else {
      const subId = `sub_${Date.now()}`;
      const newSub = {
        id: subId,
        name,
        code,
        classId,
        className: clsObj?.name || '',
        teacherId,
        teacherName: tchObj?.fullName || '',
        maxMarks,
        passMarks,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.data.subjects.push(newSub);
      if (tchObj && !tchObj.assignedSubjectIds.includes(subId)) {
        tchObj.assignedSubjectIds.push(subId);
        await syncDocumentToFirestore('teachers', tchObj.id, tchObj, OperationType.UPDATE);
      }
      await syncDocumentToFirestore('subjects', subId, newSub, OperationType.CREATE);
      await recordActivity(`Added subject ${name} (${code})`, 'Subject');
      showToast(`Added subject "${name}".`, 'success');
    }
    closeModal();
    renderApp();
  });
}

function openExamFormModal(existingExam = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const isEdit = Boolean(existingExam);
  const { classes, sections } = state.data;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="exm-modal-title">
      <div class="modal-dialog" style="max-width:540px;">
        <div class="modal-header">
          <h2 id="exm-modal-title">${isEdit ? 'Edit Examination' : 'Create Examination'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-exam-form">
          <div class="form-field">
            <label for="m-exm-name">Examination Title</label>
            <input type="text" id="m-exm-name" class="form-input" value="${escapeHtml(existingExam?.name || '')}" placeholder="e.g. Annual Final Examination 2027" required />
          </div>
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-exm-term">Term / Semester</label>
              <input type="text" id="m-exm-term" class="form-input" value="${escapeHtml(existingExam?.term || 'Semester II')}" required />
            </div>
            <div class="form-field">
              <label for="m-exm-status">Status</label>
              <select id="m-exm-status" class="form-select">
                <option value="published" ${existingExam?.status === 'published' ? 'selected' : ''}>Published</option>
                <option value="ongoing" ${existingExam?.status === 'ongoing' ? 'selected' : ''}>Ongoing</option>
                <option value="scheduled" ${existingExam?.status === 'scheduled' ? 'selected' : ''}>Scheduled</option>
                <option value="locked" ${existingExam?.status === 'locked' ? 'selected' : ''}>Locked (Final)</option>
              </select>
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-exm-class">Class</label>
              <select id="m-exm-class" class="form-select" required>
                ${classes
                  .map((c) => `<option value="${escapeHtml(c.id)}" ${existingExam?.classId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="form-field">
              <label for="m-exm-section">Section</label>
              <select id="m-exm-section" class="form-select" required>
                ${sections
                  .map((s) => `<option value="${escapeHtml(s.id)}" ${existingExam?.sectionId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
                  .join('')}
              </select>
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-field">
              <label for="m-exm-max">Default Maximum Marks</label>
              <input type="number" id="m-exm-max" class="form-input mono-code" value="${existingExam?.maxMarks || 100}" required />
            </div>
            <div class="form-field">
              <label for="m-exm-pass">Default Pass Marks</label>
              <input type="number" id="m-exm-pass" class="form-input mono-code" value="${existingExam?.passMarks || 40}" required />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Examination' : 'Create Examination'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-exam-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('m-exm-name').value.trim();
    const term = document.getElementById('m-exm-term').value.trim();
    const status = document.getElementById('m-exm-status').value;
    const classId = document.getElementById('m-exm-class').value;
    const sectionId = document.getElementById('m-exm-section').value;
    const maxMarks = Number(document.getElementById('m-exm-max').value) || 100;
    const passMarks = Number(document.getElementById('m-exm-pass').value) || 40;
    const clsObj = classes.find((c) => c.id === classId);
    const secObj = sections.find((s) => s.id === sectionId);
    const nowIso = new Date().toISOString();

    if (isEdit) {
      existingExam.name = name;
      existingExam.term = term;
      existingExam.status = status;
      existingExam.classId = classId;
      existingExam.className = clsObj?.name || '';
      existingExam.sectionId = sectionId;
      existingExam.sectionName = secObj?.name || '';
      existingExam.maxMarks = maxMarks;
      existingExam.passMarks = passMarks;
      existingExam.updatedAt = nowIso;
      await syncDocumentToFirestore('examinations', existingExam.id, existingExam, OperationType.UPDATE);
      showToast(`Examination "${name}" updated.`, 'success');
    } else {
      const newEx = {
        id: `exm_${Date.now()}`,
        name,
        academicYear: state.data.schoolSettings.academicYear,
        term,
        classId,
        className: clsObj?.name || '',
        sectionId,
        sectionName: secObj?.name || '',
        maxMarks,
        passMarks,
        status,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.data.examinations.push(newEx);
      await syncDocumentToFirestore('examinations', newEx.id, newEx, OperationType.CREATE);
      await recordActivity(`Created examination ${name}`, 'Examination');
      showToast(`Created examination "${name}".`, 'success');
    }
    closeModal();
    renderApp();
  });
}

function openMarkFormModal(existingMark = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const isEdit = Boolean(existingMark);
  const { students, examinations, subjects } = state.data;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="mrk-modal-title">
      <div class="modal-dialog" style="max-width:520px;">
        <div class="modal-header">
          <h2 id="mrk-modal-title">${isEdit ? 'Edit Student Mark Entry' : 'Add / Update Student Mark'}</h2>
          <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
        </div>
        <form id="modal-mark-form">
          <div class="form-field">
            <label for="m-mrk-student">Select Scholar</label>
            <select id="m-mrk-student" class="form-select" ${isEdit ? 'disabled' : ''} required>
              ${students
                .map(
                  (s) => `<option value="${escapeHtml(s.id)}" ${existingMark?.studentId === s.id ? 'selected' : ''}>${escapeHtml(s.fullName)} (${escapeHtml(s.admissionNo)})</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="m-mrk-exam">Select Examination</label>
            <select id="m-mrk-exam" class="form-select" ${isEdit ? 'disabled' : ''} required>
              ${examinations
                .map((ex) => `<option value="${escapeHtml(ex.id)}" ${existingMark?.examId === ex.id ? 'selected' : ''}>${escapeHtml(ex.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="m-mrk-subject">Select Subject</label>
            <select id="m-mrk-subject" class="form-select" ${isEdit ? 'disabled' : ''} required>
              ${subjects
                .map((sub) => `<option value="${escapeHtml(sub.id)}" ${existingMark?.subjectId === sub.id ? 'selected' : ''}>${escapeHtml(sub.name)} (Max ${sub.maxMarks})</option>`)
                .join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="m-mrk-obtained">Obtained Marks</label>
            <input type="number" id="m-mrk-obtained" class="form-input mono-code" min="0" max="1000" step="0.5" value="${existingMark ? existingMark.obtainedMarks : ''}" required />
          </div>
          <div class="form-field">
            <label for="m-mrk-remarks">Evaluator Remarks</label>
            <input type="text" id="m-mrk-remarks" class="form-input" value="${escapeHtml(existingMark?.remarks || '')}" />
          </div>
          <div id="m-mrk-error" style="color:var(--status-fail);font-size:0.84rem;margin-bottom:0.5rem;"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button type="submit" class="btn btn-primary">Calculate Grade &amp; Save Mark</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);

  document.getElementById('modal-mark-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const stuId = existingMark ? existingMark.studentId : document.getElementById('m-mrk-student').value;
    const examId = existingMark ? existingMark.examId : document.getElementById('m-mrk-exam').value;
    const subId = existingMark ? existingMark.subjectId : document.getElementById('m-mrk-subject').value;
    const obtainedMarks = Number(document.getElementById('m-mrk-obtained').value);
    const remarks = document.getElementById('m-mrk-remarks').value.trim();
    const errEl = document.getElementById('m-mrk-error');

    const stu = students.find((s) => s.id === stuId);
    const exam = examinations.find((ex) => ex.id === examId);
    const sub = subjects.find((s) => s.id === subId);
    const maxMarks = sub?.maxMarks || exam?.maxMarks || 100;
    const passMarks = sub?.passMarks || exam?.passMarks || 40;

    const bounds = validateMarkBounds(obtainedMarks, maxMarks, passMarks);
    if (!bounds.valid) {
      errEl.textContent = bounds.error;
      return;
    }

    const calc = calculateSubjectResult({
      obtainedMarks,
      maxMarks,
      passMarks,
      gradingScale: state.data.appSettings.gradingScaleJson
    });
    const tch = state.data.teachers.find((t) => t.id === sub?.teacherId) || state.data.teachers[0];
    const nowIso = new Date().toISOString();

    // Prevent duplicate mark entries for same student + exam + subject
    const duplicate = state.data.marks.find(
      (m) => m.studentId === stuId && m.examId === examId && m.subjectId === subId
    );

    if (duplicate) {
      duplicate.obtainedMarks = calc.obtainedMarks;
      duplicate.percentage = calc.percentage;
      duplicate.grade = calc.grade;
      duplicate.passed = calc.passed;
      duplicate.remarks = remarks;
      duplicate.updatedAt = nowIso;
      await syncDocumentToFirestore('marks', duplicate.id, duplicate, OperationType.UPDATE);
      await recordActivity(`Updated mark for ${stu.fullName} in ${sub.name} (${calc.obtainedMarks}/${maxMarks})`, 'Marks');
      showToast(`Updated mark for ${stu.fullName}: ${calc.grade} (${calc.percentage}%)`, 'success');
    } else {
      const newMark = {
        id: `mrk_${Date.now()}`,
        examId: exam.id,
        examName: exam.name,
        studentId: stu.id,
        studentUserId: stu.userId,
        studentName: stu.fullName,
        admissionNo: stu.admissionNo,
        rollNo: stu.rollNo,
        classId: stu.classId,
        className: stu.className,
        sectionId: stu.sectionId,
        sectionName: stu.sectionName,
        subjectId: sub.id,
        subjectName: sub.name,
        maxMarks,
        passMarks,
        obtainedMarks: calc.obtainedMarks,
        percentage: calc.percentage,
        grade: calc.grade,
        passed: calc.passed,
        teacherId: tch?.id || 'tch_101',
        teacherUserId: tch?.userId || state.currentUser.uid,
        remarks,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      state.data.marks.unshift(newMark);
      await syncDocumentToFirestore('marks', newMark.id, newMark, OperationType.CREATE);
      await recordActivity(`Added mark for ${stu.fullName} in ${sub.name} (${calc.obtainedMarks}/${maxMarks})`, 'Marks');
      showToast(`Saved mark for ${stu.fullName}: ${calc.grade} (${calc.percentage}%)`, 'success');
    }

    closeModal();
    renderApp();
  });
}

function openStudentMarksheetModal(studentId) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const student = state.data.students.find((s) => s.id === studentId);
  if (!student) return;
  const exam = state.data.examinations.find((e) => e.classId === student.classId) || state.data.examinations[0];
  const stuMarks = state.data.marks.filter((m) => m.studentId === student.id);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Official Student Marksheet">
      <div class="modal-dialog" style="max-width:960px;">
        <div class="modal-header no-print">
          <h2>Official Student Marksheet — ${escapeHtml(student.fullName)}</h2>
          <div style="display:flex;gap:0.5rem;">
            <button type="button" class="btn btn-primary btn-sm" id="modal-print-marksheet-btn">Print Marksheet</button>
            <button type="button" class="btn btn-secondary btn-sm" id="modal-close-btn">Close</button>
          </div>
        </div>
        ${renderOfficialMarksheetCard(student, exam, stuMarks)}
      </div>
    </div>
  `;
  document.getElementById('modal-close-btn')?.addEventListener('click', closeModal);
  document.getElementById('modal-print-marksheet-btn')?.addEventListener('click', () => window.print());
}

// ============================================================================
// 15. MAIN RENDER & EVENT DELEGATION WIRING
// ============================================================================
function renderApp() {
  applyThemeSettings();
  const root = document.getElementById('app-root');
  if (!root || !state.data) return;

  if (state.screen === 'dashboard' && state.currentUser) {
    root.innerHTML = renderDashboardShell();
  } else if (state.screen === 'login') {
    root.innerHTML = renderLoginScreen();
  } else {
    root.innerHTML = renderLandingScreen();
  }

  bindInteractiveEvents();
}

function bindInteractiveEvents() {
  const heroVideo = document.querySelector('.hero-media-frame video');
  if (heroVideo) {
    heroVideo.defaultMuted = true;
    heroVideo.muted = true;
    heroVideo.loop = true;
    heroVideo.playsInline = true;
    const tryPlay = () => {
      if (heroVideo.paused) {
        heroVideo.play().catch(() => {});
      }
    };
    tryPlay();
    heroVideo.addEventListener('loadeddata', tryPlay, { once: true });
    heroVideo.addEventListener('canplay', tryPlay, { once: true });
  }

  document.getElementById('btn-copy-supabase-sql')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
      showToast('SQL script copied! Paste and Run it in Supabase SQL Editor.', 'success');
    } catch (_err) {
      showToast('Unable to copy automatically. See supabase_schema.sql in project root.', 'info');
    }
  });

  document.getElementById('btn-retry-cloud-sync')?.addEventListener('click', async () => {
    if (state.cloudSyncBusy) return;
    state.cloudSyncBusy = true;
    renderApp();
    const res = await hydrateFromFirestoreForSession(state.currentUser, { force: true });
    if (res) {
      showToast('Connected and synced all campus records to Supabase.', 'success');
    } else if (cloudSetupNeeded) {
      showToast('Table public.educore_records not found yet. Run the SQL script in Supabase SQL Editor first.', 'error');
    } else {
      showToast('Unable to reach Supabase right now. Changes remain saved locally.', 'error');
    }
    state.cloudSyncBusy = false;
    renderApp();
  });

  // Public Topbar & Landing actions
  document.getElementById('nav-brand-home')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.screen = 'landing';
    renderApp();
  });

  document.getElementById('topbar-login-btn')?.addEventListener('click', () => {
    state.screen = 'login';
    renderApp();
  });

  document.getElementById('topbar-open-dashboard-btn')?.addEventListener('click', () => {
    state.screen = 'dashboard';
    renderApp();
  });

  document.getElementById('hero-access-portal-btn')?.addEventListener('click', () => {
    state.screen = 'login';
    renderApp();
  });

  document.querySelectorAll('[data-goto-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.loginRoleTab = btn.getAttribute('data-goto-role') || 'admin';
      state.loginError = '';
      state.screen = 'login';
      renderApp();
    });
  });

  // Public Marksheet Verification
  document.getElementById('public-verify-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('verify-adm-input')?.value || '';
    state.publicVerifyAdmissionNo = val.trim();
    renderApp();
  });

  document.getElementById('quick-verify-btn')?.addEventListener('click', () => {
    state.publicVerifyAdmissionNo = 'DHBC-2026-001';
    renderApp();
  });

  // Login Role Tabs & Form
  document.querySelectorAll('[data-login-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      state.loginRoleTab = tabBtn.getAttribute('data-login-tab') || 'admin';
      state.loginError = '';
      renderApp();
    });
  });

  document.getElementById('toggle-password-visibility-btn')?.addEventListener('click', () => {
    const uVal = document.getElementById('login-username-input')?.value || '';
    const pVal = document.getElementById('login-password-input')?.value || '';
    state.showPassword = !state.showPassword;
    renderApp();
    const uEl = document.getElementById('login-username-input');
    const pEl = document.getElementById('login-password-input');
    if (uEl) uEl.value = uVal;
    if (pEl) pEl.value = pVal;
  });

  document.getElementById('portal-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username-input')?.value || '';
    const password = document.getElementById('login-password-input')?.value || '';
    await handleUsernameLogin(username, password, state.loginRoleTab);
  });

  document.getElementById('forgot-password-help-btn')?.addEventListener('click', () => {
    openForgotPasswordModal();
  });

  // Dashboard Sidebar & Topbar Controls
  document.querySelectorAll('[data-nav-id]').forEach((navBtn) => {
    navBtn.addEventListener('click', () => {
      state.activeNav = navBtn.getAttribute('data-nav-id');
      state.sidebarOpen = false;
      renderApp();
    });
  });

  document.querySelectorAll('[data-nav-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeNav = btn.getAttribute('data-nav-jump');
      renderApp();
    });
  });

  document.getElementById('mobile-sidebar-toggle-btn')?.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    renderApp();
  });

  document.getElementById('sidebar-public-home-btn')?.addEventListener('click', () => {
    state.screen = 'landing';
    renderApp();
  });

  document.getElementById('topbar-profile-shortcut-btn')?.addEventListener('click', () => {
    state.activeNav = 'profile';
    renderApp();
  });

  document.getElementById('sidebar-logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('topbar-logout-btn')?.addEventListener('click', handleLogout);

  // Admin Overview Quick Actions
  document.querySelectorAll('[data-quick-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-quick-action');
      if (act === 'add-student') {
        state.activeNav = 'students';
        renderApp();
        openStudentFormModal();
      } else if (act === 'add-teacher') {
        state.activeNav = 'teachers';
        renderApp();
        openTeacherFormModal();
      } else if (act === 'add-exam') {
        state.activeNav = 'examinations';
        renderApp();
        openExamFormModal();
      }
    });
  });

  // Student Management Controls
  document.getElementById('btn-open-add-student')?.addEventListener('click', () => openStudentFormModal());
  document.getElementById('stu-search-input')?.addEventListener('input', (e) => {
    state.studentSearch = e.target.value;
    state.studentPage = 1;
    renderApp();
    const el = document.getElementById('stu-search-input');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
  document.getElementById('stu-class-filter')?.addEventListener('change', (e) => {
    state.studentClassFilter = e.target.value;
    state.studentPage = 1;
    renderApp();
  });
  document.getElementById('stu-section-filter')?.addEventListener('change', (e) => {
    state.studentSectionFilter = e.target.value;
    state.studentPage = 1;
    renderApp();
  });
  document.getElementById('stu-prev-page')?.addEventListener('click', () => {
    if (state.studentPage > 1) {
      state.studentPage -= 1;
      renderApp();
    }
  });
  document.getElementById('stu-next-page')?.addEventListener('click', () => {
    state.studentPage += 1;
    renderApp();
  });

  document.querySelectorAll('[data-view-marksheet-stu]').forEach((btn) => {
    btn.addEventListener('click', () => openStudentMarksheetModal(btn.getAttribute('data-view-marksheet-stu')));
  });
  document.querySelectorAll('[data-edit-stu]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stu = state.data.students.find((s) => s.id === btn.getAttribute('data-edit-stu'));
      if (stu) openStudentFormModal(stu);
    });
  });
  document.querySelectorAll('[data-delete-stu]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stu = state.data.students.find((s) => s.id === btn.getAttribute('data-delete-stu'));
      if (!stu) return;
      openConfirmDeleteModal({
        title: `Delete Student "${stu.fullName}"?`,
        message: `This will permanently remove ${stu.fullName} (${stu.admissionNo}) and their associated login account and marks from EDU CORE.`,
        onConfirm: async () => {
          state.data.students = state.data.students.filter((s) => s.id !== stu.id);
          state.data.users = state.data.users.filter((u) => u.uid !== stu.userId);
          state.data.marks = state.data.marks.filter((m) => m.studentId !== stu.id);
          await deleteDocumentFromFirestore('students', stu.id);
          await deleteDocumentFromFirestore('users', stu.userId);
          await recordActivity(`Deleted student ${stu.fullName} (${stu.admissionNo})`, 'Student');
          showToast(`Deleted student "${stu.fullName}".`, 'info');
          renderApp();
        }
      });
    });
  });

  // Teacher Management Controls
  document.getElementById('btn-open-add-teacher')?.addEventListener('click', () => openTeacherFormModal());
  document.querySelectorAll('[data-edit-teacher]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tch = state.data.teachers.find((t) => t.id === btn.getAttribute('data-edit-teacher'));
      if (tch) openTeacherFormModal(tch);
    });
  });
  document.querySelectorAll('[data-delete-teacher]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tch = state.data.teachers.find((t) => t.id === btn.getAttribute('data-delete-teacher'));
      if (!tch) return;
      openConfirmDeleteModal({
        title: `Delete Faculty "${tch.fullName}"?`,
        message: `Are you sure you want to remove ${tch.fullName} (${tch.employeeId}) from the faculty directory?`,
        onConfirm: async () => {
          state.data.teachers = state.data.teachers.filter((t) => t.id !== tch.id);
          state.data.users = state.data.users.filter((u) => u.uid !== tch.userId);
          await deleteDocumentFromFirestore('teachers', tch.id);
          await deleteDocumentFromFirestore('users', tch.userId);
          await recordActivity(`Removed faculty member ${tch.fullName}`, 'Teacher');
          showToast(`Removed faculty "${tch.fullName}".`, 'info');
          renderApp();
        }
      });
    });
  });

  // Class Management Controls
  document.getElementById('btn-open-add-class')?.addEventListener('click', () => openClassFormModal());
  document.querySelectorAll('[data-edit-class]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cls = state.data.classes.find((c) => c.id === btn.getAttribute('data-edit-class'));
      if (cls) openClassFormModal(cls);
    });
  });
  document.querySelectorAll('[data-delete-class]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cls = state.data.classes.find((c) => c.id === btn.getAttribute('data-delete-class'));
      if (!cls) return;
      openConfirmDeleteModal({
        title: `Delete Class "${cls.name}"?`,
        message: `Confirm deletion of class ${cls.name} (${cls.code}).`,
        onConfirm: async () => {
          state.data.classes = state.data.classes.filter((c) => c.id !== cls.id);
          await deleteDocumentFromFirestore('classes', cls.id);
          showToast(`Deleted class "${cls.name}".`, 'info');
          renderApp();
        }
      });
    });
  });

  // Section Management Controls
  document.getElementById('btn-open-add-section')?.addEventListener('click', () => openSectionFormModal());
  document.querySelectorAll('[data-edit-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = state.data.sections.find((s) => s.id === btn.getAttribute('data-edit-section'));
      if (sec) openSectionFormModal(sec);
    });
  });
  document.querySelectorAll('[data-delete-section]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = state.data.sections.find((s) => s.id === btn.getAttribute('data-delete-section'));
      if (!sec) return;
      openConfirmDeleteModal({
        title: `Delete Section "${sec.name}"?`,
        message: `Confirm deletion of ${sec.name} from ${sec.className}.`,
        onConfirm: async () => {
          state.data.sections = state.data.sections.filter((s) => s.id !== sec.id);
          await deleteDocumentFromFirestore('sections', sec.id);
          showToast(`Deleted section "${sec.name}".`, 'info');
          renderApp();
        }
      });
    });
  });

  // Subject Management Controls
  document.getElementById('btn-open-add-subject')?.addEventListener('click', () => openSubjectFormModal());
  document.querySelectorAll('[data-edit-subject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = state.data.subjects.find((s) => s.id === btn.getAttribute('data-edit-subject'));
      if (sub) openSubjectFormModal(sub);
    });
  });
  document.querySelectorAll('[data-delete-subject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = state.data.subjects.find((s) => s.id === btn.getAttribute('data-delete-subject'));
      if (!sub) return;
      openConfirmDeleteModal({
        title: `Delete Subject "${sub.name}"?`,
        message: `Are you sure you want to delete ${sub.name} (${sub.code})?`,
        onConfirm: async () => {
          state.data.subjects = state.data.subjects.filter((s) => s.id !== sub.id);
          await deleteDocumentFromFirestore('subjects', sub.id);
          showToast(`Deleted subject "${sub.name}".`, 'info');
          renderApp();
        }
      });
    });
  });

  // Exams & Marks Management Controls
  document.getElementById('btn-open-add-exam')?.addEventListener('click', () => openExamFormModal());
  document.getElementById('btn-open-add-mark')?.addEventListener('click', () => openMarkFormModal());
  document.querySelectorAll('[data-edit-exam]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ex = state.data.examinations.find((e) => e.id === btn.getAttribute('data-edit-exam'));
      if (ex) openExamFormModal(ex);
    });
  });
  document.querySelectorAll('[data-delete-exam]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ex = state.data.examinations.find((e) => e.id === btn.getAttribute('data-delete-exam'));
      if (!ex) return;
      openConfirmDeleteModal({
        title: `Delete Examination "${ex.name}"?`,
        message: `This will remove ${ex.name} and its associated marks.`,
        onConfirm: async () => {
          state.data.examinations = state.data.examinations.filter((e) => e.id !== ex.id);
          state.data.marks = state.data.marks.filter((m) => m.examId !== ex.id);
          await deleteDocumentFromFirestore('examinations', ex.id);
          showToast(`Deleted examination "${ex.name}".`, 'info');
          renderApp();
        }
      });
    });
  });

  document.querySelectorAll('[data-edit-mark]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mrk = state.data.marks.find((m) => m.id === btn.getAttribute('data-edit-mark'));
      if (mrk) openMarkFormModal(mrk);
    });
  });
  document.querySelectorAll('[data-delete-mark]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mrk = state.data.marks.find((m) => m.id === btn.getAttribute('data-delete-mark'));
      if (!mrk) return;
      openConfirmDeleteModal({
        title: `Delete Mark Record?`,
        message: `Remove ${mrk.studentName}'s mark in ${mrk.subjectName} (${mrk.obtainedMarks}/${mrk.maxMarks})?`,
        onConfirm: async () => {
          state.data.marks = state.data.marks.filter((m) => m.id !== mrk.id);
          await deleteDocumentFromFirestore('marks', mrk.id);
          showToast('Mark entry deleted.', 'info');
          renderApp();
        }
      });
    });
  });

  document.getElementById('marks-search-input')?.addEventListener('input', (e) => {
    state.marksSearch = e.target.value;
    renderApp();
    const el = document.getElementById('marks-search-input');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
  document.getElementById('marks-exam-filter')?.addEventListener('change', (e) => {
    state.marksExamFilter = e.target.value;
    renderApp();
  });
  document.getElementById('marks-class-filter')?.addEventListener('change', (e) => {
    state.marksClassFilter = e.target.value;
    renderApp();
  });
  document.getElementById('marks-section-filter')?.addEventListener('change', (e) => {
    state.marksSectionFilter = e.target.value;
    renderApp();
  });
  document.getElementById('marks-subject-filter')?.addEventListener('change', (e) => {
    state.marksSubjectFilter = e.target.value;
    renderApp();
  });

  // School Logo Live Preview, File Upload & Reset
  const updateSchoolLogoPreview = (urlValue) => {
    const previewImg = document.getElementById('school-logo-preview-img');
    const statusEl = document.getElementById('school-logo-source-status');
    const trimmed = String(urlValue || '').trim();
    if (previewImg) {
      previewImg.src = getSafeLogoSrc(trimmed, ASSETS.campusLogo);
    }
    if (statusEl) {
      statusEl.textContent = getSchoolLogoSourceLabel(trimmed);
    }
  };

  document.getElementById('school-logo-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const optimizedUri = await compressImageFileToDataUri(file, { maxDimension: 320, maxChars: 210000 });
      const logoInput = document.getElementById('school-logo-input');
      if (logoInput) {
        logoInput.value = optimizedUri;
      }
      updateSchoolLogoPreview(optimizedUri);
      showToast('Logo image uploaded and ready. Click "Save School Branding" to apply.', 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to process selected logo image.', 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('school-logo-input')?.addEventListener('input', (e) => {
    updateSchoolLogoPreview(e.target.value);
  });

  document.getElementById('btn-reset-school-logo')?.addEventListener('click', () => {
    const logoInput = document.getElementById('school-logo-input');
    if (logoInput) {
      logoInput.value = ASSETS.campusLogo;
    }
    updateSchoolLogoPreview(ASSETS.campusLogo);
    showToast('Default campus logo restored in preview. Click Save to apply.', 'info');
  });

  // School Branding Form
  document.getElementById('form-school-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const logoCandidate = document.getElementById('school-logo-input').value.trim();
    if (isForeignBlobUrl(logoCandidate)) {
      showToast('Temporary blob: links do not work across devices. Please use "Upload Logo Image" instead.', 'error');
      return;
    }
    if (logoCandidate.length > 245000) {
      showToast('School logo payload exceeds size limit (245 KB). Please re-upload the image.', 'error');
      return;
    }

    const s = state.data.schoolSettings;
    s.name = document.getElementById('school-name-input').value.trim();
    s.academicYear = document.getElementById('school-year-input').value.trim();
    s.campusSubtitle = document.getElementById('school-subtitle-input').value.trim();
    s.principalName = document.getElementById('school-principal-input').value.trim();
    s.phone = document.getElementById('school-phone-input').value.trim();
    s.email = document.getElementById('school-email-input').value.trim();
    s.logoUrl = logoCandidate || ASSETS.campusLogo;
    s.address = document.getElementById('school-address-input').value.trim();
    s.motto = document.getElementById('school-motto-input').value.trim();
    s.updatedAt = new Date().toISOString();

    const syncRes = await syncDocumentToFirestore('schoolSettings', 'main', s, OperationType.UPDATE);
    await recordActivity(`Updated school branding for ${s.name}`, 'School');
    showToast(
      syncRes.cloudSaved
        ? 'School branding & logo saved across all devices.'
        : 'School branding saved locally.',
      syncRes.cloudSaved ? 'success' : 'info'
    );
    renderApp();
  });

  // Application Settings Form
  document.getElementById('form-app-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = state.data.appSettings;
    cfg.appName = document.getElementById('app-name-input').value.trim();
    cfg.logoText = document.getElementById('app-logo-text-input').value.trim();
    cfg.themeMode = document.getElementById('app-theme-select').value;
    cfg.accentColor = document.getElementById('app-accent-input').value.trim();
    cfg.passPercentage = Number(document.getElementById('app-pass-pct-input').value) || 40;
    cfg.updatedAt = new Date().toISOString();

    const syncRes = await syncDocumentToFirestore('appSettings', 'main', cfg, OperationType.UPDATE);
    await recordActivity(`Updated application settings (${cfg.themeMode} theme, accent ${cfg.accentColor})`, 'Settings');
    showToast(
      syncRes.cloudSaved
        ? 'Application appearance & grading settings saved to Supabase.'
        : 'Settings saved locally.',
      syncRes.cloudSaved ? 'success' : 'info'
    );
    renderApp();
  });

  document.getElementById('btn-reset-default-theme')?.addEventListener('click', async () => {
    state.data.appSettings.themeMode = 'dark';
    state.data.appSettings.accentColor = '#FF642D';
    state.data.appSettings.appName = 'EDU CORE';
    state.data.appSettings.logoText = 'DH';
    await syncDocumentToFirestore('appSettings', 'main', state.data.appSettings, OperationType.UPDATE);
    showToast('Restored DOSLA default dark & orange design tokens.', 'info');
    renderApp();
  });

  // Teacher Marks Entry Selectors & Batch Form
  document.getElementById('tch-entry-class')?.addEventListener('change', (e) => {
    state.entryClassId = e.target.value;
    renderApp();
  });
  document.getElementById('tch-entry-section')?.addEventListener('change', (e) => {
    state.entrySectionId = e.target.value;
    renderApp();
  });
  document.getElementById('tch-entry-subject')?.addEventListener('change', (e) => {
    state.entrySubjectId = e.target.value;
    renderApp();
  });
  document.getElementById('tch-entry-exam')?.addEventListener('change', (e) => {
    state.entryExamId = e.target.value;
    renderApp();
  });

  document.getElementById('teacher-batch-marks-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const teacher = state.data.teachers.find((t) => t.userId === state.currentUser.uid);
    if (!teacher) return;

    const classId = document.getElementById('tch-entry-class')?.value;
    const sectionId = document.getElementById('tch-entry-section')?.value;
    const subjectId = document.getElementById('tch-entry-subject')?.value;
    const examId = document.getElementById('tch-entry-exam')?.value;

    const sub = state.data.subjects.find((s) => s.id === subjectId);
    const exam = state.data.examinations.find((ex) => ex.id === examId);
    if (!sub || !exam) return;

    const cohortStudents = state.data.students.filter(
      (stu) => stu.classId === classId && stu.sectionId === sectionId
    );

    const formData = new FormData(e.target);
    let savedCount = 0;

    for (const stu of cohortStudents) {
      const rawVal = formData.get(`mark_${stu.id}`);
      const remarkVal = String(formData.get(`remark_${stu.id}`) || '').trim();
      if (rawVal === null || String(rawVal).trim() === '') continue;

      const obtainedMarks = Number(rawVal);
      const check = validateMarkBounds(obtainedMarks, sub.maxMarks, sub.passMarks);
      if (!check.valid) {
        showToast(`${stu.fullName}: ${check.error}`, 'error');
        return;
      }

      const calc = calculateSubjectResult({
        obtainedMarks,
        maxMarks: sub.maxMarks,
        passMarks: sub.passMarks,
        gradingScale: state.data.appSettings.gradingScaleJson
      });

      const nowIso = new Date().toISOString();
      const existing = state.data.marks.find(
        (m) => m.studentId === stu.id && m.examId === exam.id && m.subjectId === sub.id
      );

      if (existing) {
        existing.obtainedMarks = calc.obtainedMarks;
        existing.percentage = calc.percentage;
        existing.grade = calc.grade;
        existing.passed = calc.passed;
        existing.remarks = remarkVal;
        existing.updatedAt = nowIso;
        await syncDocumentToFirestore('marks', existing.id, existing, OperationType.UPDATE);
      } else {
        const newMark = {
          id: `mrk_${Date.now()}_${stu.id}`,
          examId: exam.id,
          examName: exam.name,
          studentId: stu.id,
          studentUserId: stu.userId,
          studentName: stu.fullName,
          admissionNo: stu.admissionNo,
          rollNo: stu.rollNo,
          classId: stu.classId,
          className: stu.className,
          sectionId: stu.sectionId,
          sectionName: stu.sectionName,
          subjectId: sub.id,
          subjectName: sub.name,
          maxMarks: sub.maxMarks,
          passMarks: sub.passMarks,
          obtainedMarks: calc.obtainedMarks,
          percentage: calc.percentage,
          grade: calc.grade,
          passed: calc.passed,
          teacherId: teacher.id,
          teacherUserId: auth?.currentUser?.uid || teacher.userId,
          remarks: remarkVal,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        state.data.marks.unshift(newMark);
        await syncDocumentToFirestore('marks', newMark.id, newMark, OperationType.CREATE);
      }
      savedCount += 1;
    }

    if (savedCount > 0) {
      await recordActivity(`Saved ${savedCount} marks for ${sub.name} (${exam.name})`, 'Marks');
      showToast(`Validated and saved ${savedCount} student mark entries.`, 'success');
      renderApp();
    } else {
      showToast('Enter at least one student mark before saving.', 'info');
    }
  });

  // Student Marksheet Controls
  document.getElementById('stu-exam-selector')?.addEventListener('change', (e) => {
    state.selectedStudentExamId = e.target.value;
    renderApp();
  });
  document.getElementById('btn-print-marksheet')?.addEventListener('click', () => {
    window.print();
  });

  // Universal Profile & Password Forms
  document.getElementById('prof-avatar-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const optimizedUri = await compressImageFileToDataUri(file, { maxDimension: 320, maxChars: 210000 });
      const avatarInput = document.getElementById('prof-avatar-input');
      if (avatarInput) {
        avatarInput.value = optimizedUri;
        showToast('Image compressed and ready for profile save.', 'info');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to encode selected image.', 'error');
    }
  });

  document.getElementById('form-update-own-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = state.currentUser;
    const fullName = document.getElementById('prof-fullname-input').value.trim();
    const newUsername = normalizeUsername(document.getElementById('prof-username-input').value);
    const phone = document.getElementById('prof-phone-input').value.trim();
    const bloodGroup = document.getElementById('prof-blood-input').value.trim();
    const address = document.getElementById('prof-address-input').value.trim();
    const avatarUrl = document.getElementById('prof-avatar-input').value.trim();
    const bio = document.getElementById('prof-bio-input').value.trim();

    const clash = state.data.users.find((u) => normalizeUsername(u.username) === newUsername && u.uid !== user.uid);
    if (clash) {
      showToast(`Username "${newUsername}" is already in use.`, 'error');
      return;
    }

    const nowIso = new Date().toISOString();
    const userDoc = state.data.users.find((u) => u.uid === user.uid);
    let profileCloudSaved = false;
    if (userDoc) {
      userDoc.fullName = fullName;
      userDoc.username = newUsername;
      userDoc.avatarUrl = avatarUrl;
      userDoc.updatedAt = nowIso;
      state.currentUser = { ...userDoc };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
      const uRes = await syncDocumentToFirestore('users', userDoc.uid, userDoc, OperationType.UPDATE);
      profileCloudSaved = uRes.cloudSaved;
    }

    if (user.role === 'student') {
      const stu = state.data.students.find((s) => s.userId === user.uid);
      if (stu) {
        stu.fullName = fullName;
        stu.username = newUsername;
        stu.avatarUrl = avatarUrl;
        stu.updatedAt = nowIso;
        await syncDocumentToFirestore('students', stu.id, stu, OperationType.UPDATE);
      }
    } else if (user.role === 'teacher') {
      const tch = state.data.teachers.find((t) => t.userId === user.uid);
      if (tch) {
        tch.fullName = fullName;
        tch.username = newUsername;
        tch.avatarUrl = avatarUrl;
        tch.updatedAt = nowIso;
        await syncDocumentToFirestore('teachers', tch.id, tch, OperationType.UPDATE);
      }
    }

    const privProfile = {
      ...(state.data.privateProfiles[user.uid] || {}),
      uid: user.uid,
      phone,
      address,
      bloodGroup,
      bio,
      updatedAt: nowIso
    };
    state.data.privateProfiles[user.uid] = privProfile;
    await syncDocumentToFirestore(`users/${user.uid}/private`, 'info', privProfile, OperationType.WRITE);

    await recordActivity(`Updated personal profile (@${newUsername})`, 'Profile');
    showToast(
      profileCloudSaved ? 'Profile information updated across devices.' : 'Profile information saved locally.',
      profileCloudSaved ? 'success' : 'info'
    );
    renderApp();
  });

  document.getElementById('form-change-own-password')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPwd = document.getElementById('pwd-current-input').value;
    const newPwd = document.getElementById('pwd-new-input').value;
    const confirmPwd = document.getElementById('pwd-confirm-input').value;

    if (newPwd.length < 6) {
      showToast('New password must be at least 6 characters.', 'error');
      return;
    }
    if (newPwd !== confirmPwd) {
      showToast('New password and confirmation do not match.', 'error');
      return;
    }

    const currentHash = await hashPasswordSha256(currentPwd, state.currentUser.username);
    if (currentHash !== state.currentUser.passwordHash) {
      showToast('Current password is incorrect.', 'error');
      return;
    }

    const newHash = await hashPasswordSha256(newPwd, state.currentUser.username);
    const userDoc = state.data.users.find((u) => u.uid === state.currentUser.uid);
    if (userDoc) {
      userDoc.passwordHash = newHash;
      userDoc.mustChangePassword = false;
      userDoc.updatedAt = new Date().toISOString();
      state.currentUser = { ...userDoc };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
      await syncDocumentToFirestore('users', userDoc.uid, userDoc, OperationType.UPDATE);
    }

    await recordActivity(`Rotated account password for @${state.currentUser.username}`, 'Security');
    showToast('Password updated securely.', 'success');
    e.target.reset();
  });
}

// ============================================================================
// 16. APPLICATION BOOTSTRAP
// ============================================================================
function normalizeLoadedAssets() {
  if (!state.data?.schoolSettings) return;
  const normalizedLogo = normalizeAssetPath(state.data.schoolSettings.logoUrl, ASSETS.campusLogo);
  let assetPathsChanged = normalizedLogo !== state.data.schoolSettings.logoUrl;
  state.data.schoolSettings.logoUrl = normalizedLogo;
  if (Array.isArray(state.data.users)) {
    state.data.users.forEach((u) => {
      if (u.avatarUrl) {
        const normalizedAvatar = normalizeAssetPath(u.avatarUrl, ASSETS.adminAvatar);
        if (normalizedAvatar !== u.avatarUrl) {
          u.avatarUrl = normalizedAvatar;
          assetPathsChanged = true;
        }
      }
    });
  }
  if (assetPathsChanged) {
    saveLocalStore();
  }
}

let lastBackgroundSyncAt = 0;

async function syncCloudOnBoot() {
  try {
    await initializeEduCoreCloud();
    if (isCloudConnected) {
      await withTimeout(hydrateFromFirestoreForSession(null), 8000, false);
    }
    lastBackgroundSyncAt = Date.now();

    const migratedAdmin = state.data.users.find((u) => u.uid === 'usr_admin_dhbc' || (u.role === 'admin' && u.username === 'admin'));
    if (migratedAdmin && (migratedAdmin.username === 'admin' || migratedAdmin.mustChangePassword === true)) {
      migratedAdmin.username = 'admin00798';
      migratedAdmin.passwordHash = await hashPasswordSha256('Shakib000798', 'admin00798');
      migratedAdmin.mustChangePassword = false;
      migratedAdmin.updatedAt = new Date().toISOString();
      await syncDocumentToFirestore('users', migratedAdmin.uid, migratedAdmin, OperationType.UPDATE);
    }

    normalizeLoadedAssets();

    if (state.currentUser) {
      const freshUser = state.data.users.find((u) => u.uid === state.currentUser.uid);
      if (freshUser) {
        state.currentUser = { ...freshUser };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.currentUser));
      }
    }

    // Preserve active form/modal state if user already started interacting while cloud synced
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot && modalRoot.children.length > 0) {
      return;
    }

    const activeEl = document.activeElement;
    const savedLoginUser = document.getElementById('login-username-input')?.value;
    const savedLoginPass = document.getElementById('login-password-input')?.value;
    const activeId = activeEl && activeEl.id ? activeEl.id : '';

    if (
      activeEl &&
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) &&
      activeId !== 'login-username-input' &&
      activeId !== 'login-password-input'
    ) {
      return;
    }

    renderApp();

    if (state.screen === 'login') {
      const uEl = document.getElementById('login-username-input');
      const pEl = document.getElementById('login-password-input');
      if (uEl && savedLoginUser) uEl.value = savedLoginUser;
      if (pEl && savedLoginPass) pEl.value = savedLoginPass;
      if (activeId && document.getElementById(activeId)) {
        document.getElementById(activeId).focus();
      }
    }
  } catch (err) {
    console.warn('Background cloud sync warning:', err);
  }
}

async function bootstrapEduCore() {
  let loadedData = null;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      loadedData = JSON.parse(cached);
    }
  } catch (_e) {
    loadedData = null;
  }

  if (!loadedData || !loadedData.users || !loadedData.schoolSettings) {
    loadedData = await buildInitialCampusSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loadedData));
  }

  state.data = loadedData;

  const adminAccount = state.data.users.find((u) => u.uid === 'usr_admin_dhbc' || (u.role === 'admin' && u.username === 'admin'));
  if (adminAccount && (adminAccount.username === 'admin' || adminAccount.mustChangePassword === true)) {
    adminAccount.username = 'admin00798';
    adminAccount.passwordHash = await hashPasswordSha256('Shakib000798', 'admin00798');
    adminAccount.mustChangePassword = false;
    adminAccount.updatedAt = new Date().toISOString();
    saveLocalStore();
  }

  normalizeLoadedAssets();

  try {
    const savedSession = sessionStorage.getItem(SESSION_KEY);
    if (savedSession) {
      const parsedUser = JSON.parse(savedSession);
      const freshUser = state.data.users.find((u) => u.uid === parsedUser.uid);
      if (freshUser) {
        state.currentUser = { ...freshUser };
        state.screen = 'dashboard';
      }
    }
  } catch (_e) {
    // Ignore session restore error
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('autostart') === '1' && !state.currentUser) {
    state.screen = 'login';
  }

  // Render immediately from cache/seed so page never hangs on slow internet
  state.ready = true;
  renderApp();

  // Initialize Supabase and sync in the background (~60ms single GET)
  void syncCloudOnBoot();

  // Refresh silently when returning to tab from another device
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      isCloudConnected &&
      Date.now() - lastBackgroundSyncAt > 15000
    ) {
      void syncCloudOnBoot();
    }
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapEduCore();
}
