/**
 * EDU CORE — DARUL HUDA BENGAL CAMPUS
 * FILE 4: firebase.js
 *
 * Official Firebase JavaScript SDK (ES6 Module) Configuration & Database Layer.
 *
 * INSTRUCTIONS FOR STATIC HOSTING (NETLIFY DROP / VERCEL / GITHUB PAGES):
 * 1. Open https://console.firebase.google.com and select your Firebase project.
 * 2. Go to Project Settings > General > Your apps > Web app.
 * 3. Copy your Firebase configuration keys into `firebaseConfig` below.
 * 4. In Firebase Console > Authentication > Sign-in method, enable "Email/Password".
 * 5. In Firebase Console > Firestore Database > Rules, paste the contents of `firebase.rules`.
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword as fbUpdatePassword,
  signOut as fbSignOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  serverTimestamp
} from 'firebase/firestore';

// ============================================================================
// 1. PROVISIONED FIREBASE CONFIGURATION (WITH RUNTIME OVERRIDE SUPPORT)
// ============================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyAiEr5j5tVOp8GKRqQKix306OxHqlsFA94",
  authDomain: "gen-lang-client-0083354865.firebaseapp.com",
  projectId: "gen-lang-client-0083354865",
  storageBucket: "gen-lang-client-0083354865.firebasestorage.app",
  messagingSenderId: "763416201459",
  appId: "1:763416201459:web:e932921af2ad3e11250f86",
  firestoreDatabaseId: "ai-studio-4b281678-21f6-497e-80b2-65afa1544348"
};

// ============================================================================
// 2. FIRESTORE ERROR HANDLER (STRUCTURED DIAGNOSTICS)
// ============================================================================
export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
};

export let app = null;
export let auth = null;
export let db = null;
export let isCloudConnected = false;
export let activeProjectId = '';

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      emailVerified: auth?.currentUser?.emailVerified || null,
      isAnonymous: auth?.currentUser?.isAnonymous || null,
      tenantId: auth?.currentUser?.tenantId || null,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ============================================================================
// 3. USERNAME-TO-INTERNAL-AUTH IDENTIFIER & SHA-256 VERIFIER
// ============================================================================
export function usernameToInternalEmail(username) {
  const clean = String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '');
  return `${clean}@educore.darulhuda.campus`;
}

export async function hashPasswordSha256(plainTextPassword, usernameSalt = 'educore_dhbc') {
  const normalizedSalt = String(usernameSalt || 'educore_dhbc').trim().toLowerCase();
  const data = new TextEncoder().encode(`${normalizedSalt}::${plainTextPassword}::DHBC_2026`);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback deterministic hash if SubtleCrypto is unavailable in non-HTTPS frame
  let h = 2166136261;
  const str = `${normalizedSalt}::${plainTextPassword}::DHBC_2026`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a_${(h >>> 0).toString(16)}`;
}

// ============================================================================
// 4. INITIALIZATION & CONNECTION VALIDATION
// ============================================================================
async function resolveEffectiveConfig() {
  try {
    const response = await fetch('./firebase-applet-config.json', { cache: 'no-store' });
    if (response.ok) {
      const appletConfig = await response.json();
      if (
        appletConfig &&
        appletConfig.apiKey &&
        appletConfig.projectId &&
        appletConfig.projectId !== 'remixed-project-id'
      ) {
        return appletConfig;
      }
    }
  } catch (_err) {
    // Static deployment without firebase-applet-config.json
  }
  return firebaseConfig;
}

export async function testConnection() {
  if (!db) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }
  const attempt = async () => {
    await getDocFromServer(doc(db, 'test', 'connection'));
  };
  try {
    await attempt();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      // Retry once after brief settle delay for slow mobile connections
      await new Promise((r) => setTimeout(r, 2500));
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return false;
      }
      try {
        await attempt();
        return true;
      } catch (retryErr) {
        if (retryErr instanceof Error && retryErr.message.includes('the client is offline')) {
          console.error('Please check your Firebase configuration.');
          return false;
        }
        return true;
      }
    }
    // Permission denied on /test/connection still proves online connectivity to Firestore
    return true;
  }
}

export async function initializeEduCoreFirebase() {
  const resolvedConfig = await resolveEffectiveConfig();
  if (!resolvedConfig || !resolvedConfig.apiKey || !resolvedConfig.projectId) {
    isCloudConnected = false;
    return { connected: false, mode: 'awaiting_config' };
  }

  try {
    app = getApps().length ? getApp() : initializeApp(resolvedConfig);
    auth = getAuth(app);
    db = resolvedConfig.firestoreDatabaseId
      ? getFirestore(app, resolvedConfig.firestoreDatabaseId)
      : getFirestore(app);
    activeProjectId = resolvedConfig.projectId;
    isCloudConnected = true;
    // Validate connectivity asynchronously without blocking initial UI paint
    void testConnection();
    return { connected: true, projectId: resolvedConfig.projectId };
  } catch (err) {
    console.warn('Firebase initialization warning:', err);
    isCloudConnected = false;
    return { connected: false, error: err };
  }
}

// Re-export Firestore & Auth primitives for modular usage in app.js
export {
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  serverTimestamp,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  fbUpdatePassword,
  fbSignOut,
  onAuthStateChanged
};
