/**
 * EDU CORE — DARUL HUDA BENGAL CAMPUS
 * FILE: supabase.js
 *
 * Lightweight, high-speed Supabase PostgREST persistence layer.
 * Zero external SDK bundle overhead — uses native fetch against Supabase REST API
 * with single-roundtrip hydration and batched upserts for fast cross-device sync.
 */

export const DEFAULT_SUPABASE_CONFIG = {
  url: 'https://isgfeegychnqacdcwkbk.supabase.co',
  anonKey: 'sb_publishable_Wc3Q2OLIJQ8BmLsIoTxwPw_ePmaPkHH'
};

export const SUPABASE_TABLE = 'educore_records';

export const SUPABASE_SETUP_SQL = `CREATE TABLE IF NOT EXISTS public.educore_records (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_educore_records_collection
  ON public.educore_records (collection);

ALTER TABLE public.educore_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "educore_public_access" ON public.educore_records;
CREATE POLICY "educore_public_access"
  ON public.educore_records
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

GRANT ALL ON TABLE public.educore_records TO anon, authenticated;`;

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
};

export let isCloudConnected = false;
export let cloudSetupNeeded = false;
export let activeSupabaseUrl = '';
let activeAnonKey = '';

// ============================================================================
// 1. SHA-256 PASSWORD VERIFIER (COMPATIBLE WITH EXISTING PORTAL CREDENTIALS)
// ============================================================================
export async function hashPasswordSha256(plainTextPassword, usernameSalt = 'educore_dhbc') {
  const normalizedSalt = String(usernameSalt || 'educore_dhbc').trim().toLowerCase();
  const data = new TextEncoder().encode(`${normalizedSalt}::${plainTextPassword}::DHBC_2026`);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  const str = `${normalizedSalt}::${plainTextPassword}::DHBC_2026`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a_${(h >>> 0).toString(16)}`;
}

// ============================================================================
// 2. CONFIGURATION & REQUEST HELPERS
// ============================================================================
function resolveEffectiveConfig() {
  const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};
  const url = String(env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_CONFIG.url || '')
    .trim()
    .replace(/\/+$/, '');
  const anonKey = String(env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_CONFIG.anonKey || '').trim();
  return { url, anonKey };
}

function buildHeaders(extra = {}) {
  const headers = {
    apikey: activeAnonKey,
    'Content-Type': 'application/json',
    ...extra
  };
  if (activeAnonKey && !activeAnonKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${activeAnonKey}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, {
      ...options,
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseTableMissing(status, bodyText) {
  return status === 404 && String(bodyText || '').includes('PGRST205');
}

// ============================================================================
// 3. INITIALIZATION & CLOUD OPERATIONS
// ============================================================================
export async function initializeEduCoreCloud() {
  const cfg = resolveEffectiveConfig();
  if (!cfg.url || !cfg.anonKey) {
    isCloudConnected = false;
    return { connected: false, reason: 'missing_config' };
  }
  activeSupabaseUrl = cfg.url;
  activeAnonKey = cfg.anonKey;
  isCloudConnected = true;
  return { connected: true, url: activeSupabaseUrl };
}

export async function fetchAllCloudRecords(options = {}) {
  const { force = false } = options || {};
  if (!isCloudConnected || !activeSupabaseUrl || !activeAnonKey) {
    return { ok: false, reason: 'not_configured', rows: [] };
  }
  if (cloudSetupNeeded && !force) {
    return { ok: false, reason: 'table_missing', rows: [] };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline', rows: [] };
  }

  try {
    const endpoint = `${activeSupabaseUrl}/rest/v1/${SUPABASE_TABLE}?select=collection,doc_id,data,created_at,updated_at&limit=5000`;
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'GET',
        headers: buildHeaders({ Accept: 'application/json' }),
        cache: 'no-store'
      },
      7000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (parseTableMissing(res.status, errText)) {
        cloudSetupNeeded = true;
        return { ok: false, reason: 'table_missing', rows: [] };
      }
      return { ok: false, reason: `http_${res.status}`, error: errText, rows: [] };
    }

    cloudSetupNeeded = false;
    const rows = await res.json();
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err, rows: [] };
  }
}

export async function upsertCloudRecord(collectionName, docId, payload) {
  if (!isCloudConnected || !activeSupabaseUrl || !activeAnonKey) {
    return { ok: false, reason: 'not_configured' };
  }
  if (cloudSetupNeeded) {
    return { ok: false, reason: 'table_missing' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const endpoint = `${activeSupabaseUrl}/rest/v1/${SUPABASE_TABLE}?on_conflict=collection,doc_id`;
    const nowIso = new Date().toISOString();
    const row = {
      collection: String(collectionName),
      doc_id: String(docId),
      data: payload,
      updated_at: nowIso
    };
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: buildHeaders({
          Prefer: 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(row)
      },
      7000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (parseTableMissing(res.status, errText)) {
        cloudSetupNeeded = true;
        return { ok: false, reason: 'table_missing' };
      }
      return { ok: false, reason: `http_${res.status}`, error: errText };
    }

    cloudSetupNeeded = false;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err };
  }
}

export async function upsertCloudBatch(items) {
  if (!isCloudConnected || !activeSupabaseUrl || !activeAnonKey) {
    return { ok: false, reason: 'not_configured' };
  }
  if (cloudSetupNeeded) {
    return { ok: false, reason: 'table_missing' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, count: 0 };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const endpoint = `${activeSupabaseUrl}/rest/v1/${SUPABASE_TABLE}?on_conflict=collection,doc_id`;
    const nowIso = new Date().toISOString();
    const batchSize = 40;
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize).map((item) => ({
        collection: String(item.collection),
        doc_id: String(item.doc_id),
        data: item.data,
        updated_at: nowIso
      }));
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: buildHeaders({
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify(chunk)
        },
        9000
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (parseTableMissing(res.status, errText)) {
          cloudSetupNeeded = true;
          return { ok: false, reason: 'table_missing' };
        }
        return { ok: false, reason: `http_${res.status}`, error: errText };
      }
    }
    cloudSetupNeeded = false;
    return { ok: true, count: items.length };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err };
  }
}

export async function deleteCloudRecord(collectionName, docId) {
  if (!isCloudConnected || !activeSupabaseUrl || !activeAnonKey) {
    return { ok: false, reason: 'not_configured' };
  }
  if (cloudSetupNeeded) {
    return { ok: false, reason: 'table_missing' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const endpoint = `${activeSupabaseUrl}/rest/v1/${SUPABASE_TABLE}?collection=eq.${encodeURIComponent(
      String(collectionName)
    )}&doc_id=eq.${encodeURIComponent(String(docId))}`;
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: 'DELETE',
        headers: buildHeaders({ Prefer: 'return=minimal' })
      },
      7000
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (parseTableMissing(res.status, errText)) {
        cloudSetupNeeded = true;
        return { ok: false, reason: 'table_missing' };
      }
      return { ok: false, reason: `http_${res.status}`, error: errText };
    }

    cloudSetupNeeded = false;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err };
  }
}
