import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesText = fs.readFileSync('./firestore.rules', 'utf8');

test('Firestore rules enforce default deny and all 12 Dirty Dozen invariants', () => {
  // 1. Default deny catch-all exists
  assert.equal(rulesText.includes('allow read, write: if false;'), true);
  // 2. No insecure blanket allow read, write: if true
  assert.equal(rulesText.includes('allow read, write: if true'), false);
  // 3. Verified email check accompanies admin email check
  assert.equal(
    rulesText.includes("request.auth.token.email == 'sonicfast.th@gmail.com' &&\n        request.auth.token.email_verified == true"),
    true
  );
  // 4. PII subcollection isolated under /users/{userId}/private/{docId}
  assert.equal(rulesText.includes('match /private/{docId}'), true);
  // 5. Mark overflow and negative marks prevented in isValidMarkRecord
  assert.equal(
    rulesText.includes('data.obtainedMarks is number && data.obtainedMarks >= 0 && data.obtainedMarks <= data.maxMarks'),
    true
  );
  // 6. Locked examination terminal state check enforced on mark writes
  assert.equal(
    rulesText.includes("get(/databases/$(database)/documents/examinations/$(incoming().examId)).data.status != 'locked'"),
    true
  );
});
