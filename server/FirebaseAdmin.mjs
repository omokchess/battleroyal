/** Optional Firebase Admin integration for authenticated online matches. */

import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

function canInitialize() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID
    || process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || process.env.FIREBASE_SERVICE_ACCOUNT_B64
    || process.env.FIREBASE_CONFIG
  );
}

export function createFirebaseServices({ log = () => {} } = {}) {
  if (!canInitialize()) {
    log('[firebase-admin] credentials absent; authenticated users fall back to guest identity');
    return { enabled: false, verifyIdToken: async () => null, recordMatch: async () => null };
  }

  try {
    const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const serviceAccount = encodedServiceAccount
      ? JSON.parse(Buffer.from(encodedServiceAccount, 'base64').toString('utf8'))
      : null;
    const app = getApps()[0] || initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    });
    const auth = getAuth(app);
    const db = getFirestore(app);
    return {
      enabled: true,
      verifyIdToken: async (token) => {
        if (!token) return null;
        const decoded = await auth.verifyIdToken(token, true);
        let profileName = '';
        try {
          const profile = await db.doc(`profiles/${decoded.uid}`).get();
          profileName = profile.exists ? String(profile.data()?.username || '') : '';
        } catch { /* token identity still remains valid */ }
        return { uid: decoded.uid, name: profileName || decoded.name || decoded.email || '' };
      },
      recordMatch: (identity, stats, matchId) => recordMatch(db, identity, stats, matchId),
    };
  } catch (error) {
    log(`[firebase-admin] disabled: ${error?.message || error}`);
    return { enabled: false, verifyIdToken: async () => null, recordMatch: async () => null };
  }
}

async function recordMatch(db, identity, raw, matchId) {
  if (!identity?.uid) return null;
  const uid = identity.uid;
  const kills = Math.max(0, Math.min(100, Math.floor(Number(raw?.kills) || 0)));
  const deaths = Math.max(0, Math.min(100, Math.floor(Number(raw?.deaths) || 0)));
  const durationMs = Math.max(0, Math.min(60 * 60 * 1000, Math.floor(Number(raw?.durationMs) || 0)));
  const weapon = typeof raw?.weapon === 'string' ? raw.weapon.slice(0, 80) : null;
  const profileRef = db.doc(`profiles/${uid}`);
  const logRef = db.doc(`profiles/${uid}/match_logs/${String(matchId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}`);

  return db.runTransaction(async (tx) => {
    const [profileSnap, logSnap] = await Promise.all([tx.get(profileRef), tx.get(logRef)]);
    if (!profileSnap.exists || logSnap.exists) return null;
    const profile = profileSnap.data() || {};
    const lastMs = profile.last_match_at?.toMillis?.() || 0;
    if (lastMs && Date.now() - lastMs < 60_000) return null;
    const today = kstDateKey();
    const daily = profile.last_daily_at !== today ? 50 : 0;
    tx.update(profileRef, {
      coins: Number(profile.coins || 0) + kills * 10 + 20 + daily,
      total_kills: Number(profile.total_kills || 0) + kills,
      total_deaths: Number(profile.total_deaths || 0) + deaths,
      games_played: Number(profile.games_played || 0) + 1,
      last_match_at: FieldValue.serverTimestamp(),
      last_daily_at: today,
      updated_at: FieldValue.serverTimestamp(),
    });
    tx.set(logRef, { weapon, kills, deaths, duration_ms: durationMs, authoritative: true, created_at: FieldValue.serverTimestamp() });
    return { kills, deaths };
  });
}

function kstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
