# EDU CORE — Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Privilege & Role Integrity**: No client can self-assign `role: "admin"` or `role: "teacher"` in `/users/{userId}` unless already authenticated as a verified Admin (`/admins/{uid}` or bootstrapped admin email).
2. **PII Isolation**: Personal Identifiable Information (`phone`, `address`, `guardianName`, `dateOfBirth`) is stored strictly inside `/users/{userId}/private/{docId}` and is readable ONLY by the document owner (`request.auth.uid == userId`) or an Admin (`isAdmin()`).
3. **Student Record Protection**: Students can read only their own `/students/{studentId}` record (`resource.data.userId == request.auth.uid`) and their own `/marks/{markId}` records (`resource.data.studentUserId == request.auth.uid`). Students can NEVER create, update, or delete academic marks, admission numbers, roll numbers, classes, or sections.
4. **Teacher Assignment & Mark Bounds**: Teachers can create or update `/marks/{markId}` only when `incoming().teacherUserId == request.auth.uid`, `incoming().obtainedMarks >= 0`, `incoming().obtainedMarks <= incoming().maxMarks`, and the parent examination is not locked (`status != 'locked'`).
5. **Strict Key & Size Enforcement**: Every string is bounded by `.size() <= MAX`, every ID matches `^[a-zA-Z0-9_\-]+$`, and every write validates exact allowed/required keys via `isValid[Entity]()`.
6. **Temporal Integrity**: `createdAt` is immutable on update (`incoming().createdAt == existing().createdAt`), and timestamps are validated against `request.time`.

## 2. The "Dirty Dozen" Payloads

1. **Self-Admin Escalation**: Unprivileged user creates `/users/uid123` with `{ role: "admin" }`.
2. **Shadow Field Injection**: Authenticated user updates `/users/uid123` with an undeclared field `{ isSuperUser: true }`.
3. **Unverified Admin Email Spoof**: User with `email == "sonicfast.th@gmail.com"` but `email_verified == false` attempts to write to `/classes/cls1`.
4. **Cross-Student PII Theft**: Student `uid_student_A` performs `get` on `/users/uid_student_B/private/info`.
5. **Cross-Student Mark Scraping**: Student `uid_student_A` performs `list` or `get` on `/marks` where `studentUserId == "uid_student_B"`.
6. **Student Academic Tampering**: Student `uid_student_A` attempts to update `admissionNo` or `rollNo` on `/students/stu_1`.
7. **Mark Overflow Attack**: Teacher submits `/marks/mk_1` with `obtainedMarks: 150` when `maxMarks: 100`.
8. **Negative Mark Injection**: Teacher submits `/marks/mk_1` with `obtainedMarks: -10`.
9. **Teacher Identity Spoofing on Marks**: Teacher `uid_teacher_A` submits a mark with `teacherUserId: "uid_teacher_B"`.
10. **Locked Exam Mutation**: Teacher attempts to update `/marks/mk_1` after the mark record or exam is locked, or modifies immutable `createdAt`.
11. **ID Poisoning / Oversized Payload**: Attacker attempts to create `/classes/invalid$id!with*spaces` or a `name` string exceeding 80 characters.
12. **Unbounded Array Injection**: Attacker attempts to write 500 elements into `assignedClassIds` on `/teachers/tch_1` (limit is 50).
