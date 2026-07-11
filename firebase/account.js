/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  linkWithPopup,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { firebaseAuth, firestore, isFirebaseConfigured } from './client.js';

const ID_EMAIL_DOMAIN = 'battleroyale.app';

function idToEmail(id) {
  return `${String(id || '').trim().toLowerCase()}@${ID_EMAIL_DOMAIN}`;
}

function cleanUsername(name, fallback = 'Player') {
  const value = String(name || '').trim();
  return value ? value.slice(0, 20) : fallback;
}

function baseProfile(user, username) {
  const rawName = username || user?.displayName || user?.email?.split('@')[0] || 'Player';
  return {
    id: user.uid,
    username: cleanUsername(rawName),
    coins: 0,
    total_kills: 0,
    total_deaths: 0,
    games_played: 0,
    equipped_costume: 'default',
    equipped_weaponskins: {},
    equipped_killfx: 'none',
    equipped_dashtrail: 'none',
    equipped_respawnfx: 'none',
    equipped_title: 'none',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  };
}

function normalizeProfile(id, data) {
  if (!data) return null;
  return {
    id,
    username: data.username || 'Player',
    coins: Number(data.coins || 0),
    total_kills: Number(data.total_kills || 0),
    total_deaths: Number(data.total_deaths || 0),
    games_played: Number(data.games_played || 0),
    equipped_costume: data.equipped_costume || 'default',
    equipped_weaponskins: data.equipped_weaponskins || {},
    equipped_killfx: data.equipped_killfx || 'none',
    equipped_dashtrail: data.equipped_dashtrail || 'none',
    equipped_respawnfx: data.equipped_respawnfx || 'none',
    equipped_title: data.equipped_title || 'none',
    last_match_at: data.last_match_at || null,
    last_daily_at: data.last_daily_at || null,
  };
}

export async function ensureUserProfile(user, username = null) {
  if (!firestore || !user) return null;
  const ref = doc(firestore, 'profiles', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, baseProfile(user, username));
    await setDoc(doc(firestore, 'profiles', user.uid, 'user_items', 'costume:default'), {
      item_id: 'costume:default',
      acquired_at: serverTimestamp(),
    });
    await setDoc(doc(firestore, 'profiles', user.uid, 'user_costumes', 'default'), {
      costume_id: 'default',
      acquired_at: serverTimestamp(),
    });
    const fresh = await getDoc(ref);
    return normalizeProfile(user.uid, fresh.data());
  }
  return normalizeProfile(user.uid, snap.data());
}

export async function signUpWithId(id, password) {
  if (!firebaseAuth) throw new Error('Firebase가 설정되지 않았습니다');
  const cleanId = String(id || '').trim();
  const cred = await createUserWithEmailAndPassword(firebaseAuth, idToEmail(cleanId), password);
  try { await ensureUserProfile(cred.user, cleanId); }
  catch (error) { console.error('[firebase] ensure profile after signup failed', error); }
  return cred.user;
}

export async function signInWithId(id, password) {
  if (!firebaseAuth) throw new Error('Firebase가 설정되지 않았습니다');
  const cred = await signInWithEmailAndPassword(firebaseAuth, idToEmail(id), password);
  try { await ensureUserProfile(cred.user, id); }
  catch (error) { console.error('[firebase] ensure profile after signin failed', error); }
  return cred.user;
}

export async function signInWithGoogle() {
  if (!firebaseAuth) return;
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(firebaseAuth, provider);
  try { await ensureUserProfile(cred.user); }
  catch (error) { console.error('[firebase] ensure profile after google signin failed', error); }
  return cred.user;
}

export async function signOut() {
  if (!firebaseAuth) return;
  await firebaseSignOut(firebaseAuth);
}

export async function getSession() {
  if (!firebaseAuth?.currentUser) return null;
  return { user: firebaseAuth.currentUser };
}

/** Short-lived identity proof for the dedicated game server. */
export async function getIdToken(forceRefresh = false) {
  return firebaseAuth?.currentUser?.getIdToken?.(forceRefresh) || null;
}

/** Profile photo URL. For id/password users who linked Google, the top-level
 *  photoURL stays null, so fall back to the google.com provider entry. */
export function getPhotoURL() {
  const u = firebaseAuth?.currentUser;
  if (!u) return null;
  if (u.photoURL) return u.photoURL;
  const g = u.providerData?.find((p) => p.providerId === 'google.com');
  return g?.photoURL || null;
}

/** Whether the current user already has a Google provider linked. */
export function hasGoogleLinked() {
  return Boolean(firebaseAuth?.currentUser?.providerData?.some((p) => p.providerId === 'google.com'));
}

/** Link a Google account to the signed-in user (so they get a photo + Google login). */
export async function linkGoogle() {
  if (!firebaseAuth?.currentUser) throw new Error('로그인이 필요합니다');
  const provider = new GoogleAuthProvider();
  await linkWithPopup(firebaseAuth.currentUser, provider);
}

export function onAuthChange(cb) {
  if (!firebaseAuth) return () => {};
  return onAuthStateChanged(firebaseAuth, user => {
    cb(user ? { user } : null);
  });
}

export async function fetchMyProfile() {
  if (!firestore || !firebaseAuth?.currentUser) return null;
  return ensureUserProfile(firebaseAuth.currentUser);
}

export async function updateUsername(name) {
  if (!firestore || !firebaseAuth?.currentUser) return null;
  const uid = firebaseAuth.currentUser.uid;
  const ref = doc(firestore, 'profiles', uid);
  const username = cleanUsername(name);
  return runTransaction(firestore, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('프로필이 없습니다');
    tx.update(ref, { username, updated_at: serverTimestamp() });
    return normalizeProfile(uid, { ...snap.data(), username });
  });
}

export { isFirebaseConfigured };
