/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  signUpWithId,
  signInWithId,
  signInWithGoogle,
  signOut,
  onAuthChange,
  fetchMyProfile,
  isFirebaseConfigured,
  getPhotoURL,
  linkGoogle,
  hasGoogleLinked,
  updateUsername,
} from '../firebase/account.js';
import {
  fetchLeaderboard,
  fetchCostumes,
  fetchMyCostumeIds,
  recordMatch,
  fetchItems,
  fetchMyItemIds,
  fetchMyEquipped,
  equippedFromProfile,
  purchaseItem,
  equipItem,
  adminAddCoins,
  adminGrantAllItems,
  checkIsAdmin,
  publishWorkshopWeapon,
  fetchPublishedWorkshopWeapons,
  fetchMyWorkshopWeapons,
  likeWorkshopWeapon,
  reportWorkshopWeapon,
  setWorkshopWeaponStatus,
} from '../firebase/game-api.js';
import { ASSET_VERSION } from '../game/SpriteAtlas.js';
import { clampWorkshopWeapon } from '../game/Workshop.js';
import { WEAPON_LIST, WEAPON_SKIN_DEFS } from '../firebase/catalog.js';

/**
 * 계정(로그인/상단바) + 랭킹 + 상점 UI 를 담당.
 * main.js 는 init() 한 번만 호출하고, 콜백으로 로비 전환을 처리합니다.
 */

// ── 내부 상태 ───────────────────────────────────────────────
let profile = null;            // { id, username, coins, total_kills, equipped_costume }
let isAdmin = false;           // /admins/{uid} 문서 존재 여부
let costumeCatalog = [];       // [{ id, name, price, color, accent_color }]
let ownedIds = new Set();      // 보유 코스튬 id (레거시 — getEquippedCostume 용)
let callbacks = {};            // { onEnterLobby, onRequireLogin }

// 범용 상점(카테고리 탭) 상태.
let itemCatalog = [];          // [{ id, category, name, price, data, unlock_type, unlock_threshold }]
let ownedItemIds = new Set();  // 보유 아이템 id
let equipped = equippedFromProfile(null); // { costume, weaponskin, killfx, dashtrail, respawnfx, title } (전체 id)
let activeCategory = 'weaponskin';
let activeSkinWeapon = 'sword'; // 무기 스킨 탭에서 선택된 무기

const WEAPON_KO = {
  axe: '도끼', bow: '활', chakram: '부메랑', crossbow: '쇠뇌', dagger: '단검',
  flamethrower: '불지팡이', greatsword: '대검', guardian: '디펜더',
  hammer: '망치', harpoon: '작살', katana: '커틀레스', magicstaff: '지팡이',
  rapier: '레이피어', scythe: '낫', sniper: '강궁', spear: '창', sword: '검',
};

const SHOP_CATEGORIES = [
  { key: 'weaponskin', label: '무기 스킨' },
  { key: 'killfx',     label: '처치 이펙트' },
  { key: 'dashtrail',  label: '대시 트레일' },
  { key: 'respawnfx',  label: '부활 이펙트' },
  { key: 'title',      label: '칭호' },
];

// ── DOM 헬퍼 ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const COSTUME_EXTRAS = {
  crimson: { decoration: 'crest', effect: 'embers', label: 'Crest + embers' },
  emerald: { decoration: 'wings', effect: 'leaves', label: 'Wings + motes' },
  gold: { decoration: 'crown', effect: 'sparkles', label: 'Crown + shine' },
  violet: { decoration: 'halo', effect: 'runes', label: 'Halo + runes' },
  shadow: { decoration: 'cape', effect: 'shade', label: 'Cape + shade' }
};

function costumeExtras(id) {
  return COSTUME_EXTRAS[id] || { decoration: null, effect: null, label: 'Color only' };
}

// ── 공개 API ────────────────────────────────────────────────

/** 현재 로그인 프로필(없으면 null) */
export function getProfile() {
  return profile;
}

/** 게임에 넘길 착용 코스튬 색. 미로그인/기본이면 null → 기존 해시색 사용. */
export function getEquippedCostume() {
  if (!profile) return null;
  const c = costumeCatalog.find((x) => x.id === profile.equipped_costume);
  if (!c || c.id === 'default') return null;
  const extras = costumeExtras(c.id);
  return {
    color: c.color,
    accentColor: c.accent_color,
    decoration: extras.decoration,
    effect: extras.effect
  };
}

/** 로비 닉네임 입력 기본값 */
export function getUsername() {
  return profile?.username || '';
}

/** 닉네임을 계정에 저장(영속). 성공 시 로컬 프로필·상단바도 갱신. */
export async function saveUsername(name) {
  const clean = await updateUsername(name);
  const finalName = (typeof clean === 'string' && clean) || String(name || '').trim().slice(0, 20);
  if (profile) profile.username = finalName;
  const nameEl = $('accountName');
  if (nameEl) nameEl.textContent = finalName;
  return finalName;
}

/** Google 프로필 사진 URL (id/비번 로그인은 null) */
export function getAvatarUrl() {
  return getPhotoURL();
}

/** 현재 계정에 구글이 연동돼 있는지 */
export function isGoogleLinked() {
  return hasGoogleLinked();
}

/** True when the signed-in user is an admin (/admin/{uid} exists). */
export function isAdminUser() {
  return !!isAdmin;
}

// ── Workshop weapons (Tier 2). Every fetched def is RE-CLAMPED through the
//    balance envelope so a tampered Firestore doc can never enter the game unsafe.
function clampFetched(w) {
  const safe = clampWorkshopWeapon({ name: w.name, desc: w.desc, color: w.color, stats: w.stats, motionSet: w.motionSet, blocks: w.blocks });
  return { id: w.id, author_id: w.author_id, author_name: w.author_name, likes: w.likes, plays: w.plays, status: w.status, ...safe };
}
export function publishMyWorkshopWeapon(def) { return publishWorkshopWeapon(def, getUsername()); }
export async function browseWorkshopWeapons(sort = 'likes', max = 40) { return (await fetchPublishedWorkshopWeapons(sort, max)).map(clampFetched); }
export async function myWorkshopWeapons() { return (await fetchMyWorkshopWeapons()).map(clampFetched); }
export function likeWorkshop(id) { return likeWorkshopWeapon(id); }
export function reportWorkshop(id) { return reportWorkshopWeapon(id); }
export function moderateWorkshop(id, status) { return setWorkshopWeaponStatus(id, status); }

/** 구글 계정 연동 (성공 시 프로필 사진 사용 가능) */
export async function linkGoogleAccount() {
  await linkGoogle();
  return getPhotoURL();
}

/** 누적 처치 수 (티어 산출용) */
export function getTotalKills() {
  return profile?.total_kills || 0;
}

/** 누적 데스 수 */
export function getTotalDeaths() {
  return profile?.total_deaths || 0;
}

/** 티어 점수: 1킬당 +4, 1데스당 −10 (0 미만으로 안 떨어짐). */
export function getTierScore() {
  return Math.max(0, (profile?.total_kills || 0) * 4 - (profile?.total_deaths || 0) * 10);
}

/**
 * 게임에 넘길 착용 코스메틱 전체 세트(치장 전용). 각 카테고리의 표현 데이터를
 * 풀어서 반환 → P2P 로 다른 플레이어에게 전달해 그대로 그릴 수 있게 한다.
 */
export function getEquippedCosmetics() {
  const resolve = (cat) => {
    const id = equipped[cat] || (cat + ':none');
    const item = itemCatalog.find((i) => i.id === id);
    return { id, data: item?.data || {} };
  };
  return {
    weaponskins: equipped.weaponskins || {},
    killfx: resolve('killfx'),
    dashtrail: resolve('dashtrail'),
    respawnfx: resolve('respawnfx'),
    title: resolve('title'),
  };
}

export function getEquippedWeaponSkins() {
  return equipped.weaponskins || {};
}

/**
 * 초기화: 버튼 배선 + 인증 상태 구독.
 * @param {{ onEnterLobby: (profile|null)=>void, onRequireLogin: ()=>void }} cbs
 */
export function init(cbs) {
  callbacks = cbs || {};
  wireStaticButtons();

  // Firebase 미설정 → 게스트 모드(로그인 없이 바로 플레이, 계정기능 숨김)
  if (!isFirebaseConfigured) {
    setGuestMode();
    callbacks.onEnterLobby?.(null);
    return;
  }

  // 인증 상태 변화 구독 (초기 INITIAL_SESSION 포함). 리디렉션 복귀도 여기서 처리.
  onAuthChange((session) => {
    // 인증 콜백 안에서 직접 await 하면 UI 전환이 꼬일 수 있어 다음 틱으로 미룸.
    setTimeout(() => handleSession(session), 0);
  });
}

/** 매치 종료 후 코인/킬 갱신용: 프로필 재조회 & 상단바 갱신 */
export async function refreshProfile() {
  if (!isFirebaseConfigured) return null;
  profile = await fetchMyProfile();
  renderAccountBar();
  return profile;
}

/**
 * 한 판 결과를 서버에 기록하고 코인/상단바 갱신.
 * @param {number|{kills:number, deaths?:number, weapon?:string, durationMs?:number}} stats
 * 킬이 0이어도 판 완료/일일 보너스를 위해 기록한다(서버가 60초 속도 제한으로 보호).
 */
export async function reportMatch(stats) {
  if (!isFirebaseConfigured || !profile) return;
  const s = (typeof stats === 'object' && stats !== null) ? stats : { kills: stats };
  const updated = await recordMatch(s);
  if (updated) {
    profile = updated;
    renderAccountBar();
  }
}

// ── 내부 로직 ───────────────────────────────────────────────

async function handleSession(session) {
  if (session) {
    profile = await fetchMyProfile();
    // 코스튬 카탈로그/보유목록은 한 번만 받아두면 됨(상점 열 때 갱신)
    if (!costumeCatalog.length) costumeCatalog = await fetchCostumes();
    ownedIds = await fetchMyCostumeIds();
    // 범용 카탈로그 + 보유 + 착용(전체 카테고리)
    if (!itemCatalog.length) itemCatalog = await fetchItems();
    ownedItemIds = await fetchMyItemIds();
    equipped = await fetchMyEquipped();
    isAdmin = await checkIsAdmin();
    renderAccountBar();
    callbacks.onEnterLobby?.(profile);
  } else {
    profile = null;
    callbacks.onRequireLogin?.();
  }
}

function setGuestMode() {
  const bar = $('accountBar');
  if (bar) bar.classList.add('hidden');
  const note = $('authNote');
  if (note) {
    note.textContent = 'Firebase 미설정 - 로그인 없이 게스트로 플레이합니다.';
    note.classList.remove('hidden');
  }
}

function showAuthNote(msg, colorClass = 'text-yellow-400') {
  const note = $('authNote');
  if (!note) return;
  note.textContent = msg;
  note.className = 'mt-4 font-mono text-[11px] leading-snug ' + colorClass;
}

// Firebase 영문 에러 메시지를 친절한 한국어로 변환
function authErrorMessage(e) {
  const m = String(e?.message || e || '').toLowerCase();
  if (m.includes('invalid-credential') || m.includes('wrong-password') || m.includes('user-not-found') || m.includes('invalid login'))
    return '아이디 또는 비밀번호가 올바르지 않습니다.';
  if (m.includes('email-already-in-use') || m.includes('already registered') || m.includes('already been registered') || m.includes('user already'))
    return '이미 사용 중인 아이디입니다. 로그인하거나 다른 아이디를 쓰세요.';
  if (m.includes('weak-password') || m.includes('weak password') || m.includes('should be at least') || (m.includes('password') && m.includes('6')))
    return '비밀번호가 너무 짧습니다 (6자 이상).';
  if (m.includes('operation-not-allowed') || m.includes('signups not allowed') || m.includes('signup is disabled'))
    return '로그인 제공자가 비활성화되어 있습니다 (Firebase Authentication 설정 확인).';
  return '오류: ' + (e?.message || e);
}

// 아이디/비밀번호 입력값 검증 후 반환 (실패 시 null + 안내)
function readCredentials() {
  const id = ($('authId')?.value || '').trim();
  const pw = $('authPw')?.value || '';
  if (!/^[A-Za-z0-9._-]{2,20}$/.test(id)) {
    showAuthNote('아이디는 영문/숫자 2~20자로 입력하세요.');
    return null;
  }
  if (pw.length < 6) {
    showAuthNote('비밀번호는 6자 이상이어야 합니다.');
    return null;
  }
  return { id, pw };
}

// Auth calls can hang forever on a bad network (the Firebase SDK retries its
// streaming channels silently) — the UI must never sit on "가입 중..." with no
// way out. Race every auth call against a timeout and tell the user what to do.
const AUTH_TIMEOUT_MS = 12000;
function withAuthTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('auth-timeout')), AUTH_TIMEOUT_MS)),
  ]);
}
const isAuthTimeout = (e) => String(e?.message || '').includes('auth-timeout');

function wireStaticButtons() {
  // 아이디 + 비밀번호 로그인
  $('loginBtn')?.addEventListener('click', async () => {
    const c = readCredentials();
    if (!c) return;
    showAuthNote('로그인 중...', 'text-gray-400');
    try {
      await withAuthTimeout(signInWithId(c.id, c.pw));
      // 성공 시 onAuthChange 가 로비로 전환
    } catch (e) {
      showAuthNote(isAuthTimeout(e)
        ? '네트워크 응답이 없어요. 연결을 확인하고 다시 시도해 주세요.'
        : authErrorMessage(e));
    }
  });

  // 아이디 + 비밀번호 회원가입
  $('signupBtn')?.addEventListener('click', async () => {
    const c = readCredentials();
    if (!c) return;
    showAuthNote('가입 중...', 'text-gray-400');
    try {
      const session = await withAuthTimeout(signUpWithId(c.id, c.pw));
      if (!session) {
        showAuthNote('가입 완료! "로그인"을 눌러주세요.', 'text-teal-300');
      }
    } catch (e) {
      showAuthNote(isAuthTimeout(e)
        ? '네트워크가 느려 확인하지 못했어요. 계정은 만들어졌을 수 있으니 같은 아이디로 로그인해 보세요.'
        : authErrorMessage(e));
    }
  });

  // 구글 로그인 (성공 시 onAuthChange 가 프로필을 불러와 로비로 전환)
  $('googleLoginBtn')?.addEventListener('click', async () => {
    showAuthNote('구글 로그인 중...', 'text-gray-400');
    try {
      await signInWithGoogle();
    } catch (e) {
      showAuthNote(authErrorMessage(e));
    }
  });

  // Enter 키로 로그인
  $('authPw')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn')?.click();
  });

  $('logoutBtn')?.addEventListener('click', async () => {
    await signOut();
    // onAuthChange 가 onRequireLogin 을 호출 → main.js 가 게이트 표시
  });

  $('rankBtn')?.addEventListener('click', openLeaderboard);
  $('shopBtn')?.addEventListener('click', openShop);
  $('adminBtn')?.addEventListener('click', openAdmin);

  // 모달 닫기 (배경/버튼 공용)
  document.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const id = el.getAttribute('data-close-modal');
      if (e.target === el || el.tagName === 'BUTTON') $(id)?.classList.add('hidden');
    });
  });

  // 어드민 패널 버튼
  document.querySelectorAll('[data-admin-coins]').forEach((el) => {
    el.addEventListener('click', async () => {
      const amount = Number(el.dataset.adminCoins);
      await adminAction(async () => {
        const next = await adminAddCoins(amount);
        if (profile) { profile = { ...profile, coins: next }; renderAccountBar(); }
        const coinEl = $('shopCoins');
        if (coinEl) coinEl.textContent = next;
        return `코인 ${amount.toLocaleString()} 지급 완료 (현재 ${next.toLocaleString()})`;
      });
    });
  });

  $('adminGrantAll')?.addEventListener('click', async () => {
    await adminAction(async () => {
      const count = await adminGrantAllItems();
      ownedItemIds = await fetchMyItemIds();
      renderShop();
      return count > 0 ? `${count}개 아이템 해금 완료` : '이미 전부 보유 중';
    });
  });
}

async function openAdmin() {
  $('adminModal')?.classList.remove('hidden');
  setAdminStatus('');
}

async function adminAction(fn) {
  const el = $('adminStatus');
  if (el) el.textContent = '처리 중...';
  try {
    const msg = await fn();
    if (el) el.textContent = msg || '완료';
  } catch (e) {
    if (el) el.textContent = `오류: ${e?.message || e}`;
  }
}

function setAdminStatus(msg) {
  const el = $('adminStatus');
  if (el) el.textContent = msg;
}

function renderAccountBar() {
  const bar = $('accountBar');
  if (!bar) return;
  bar.classList.remove('hidden');
  if (profile) {
    const nameEl = $('accountName');
    const coinEl = $('accountCoins');
    if (nameEl) nameEl.textContent = profile.username;
    if (coinEl) coinEl.textContent = Number(profile.coins || 0).toLocaleString();
  }
  $('adminBtn')?.classList.toggle('hidden', !profile || !isAdmin);
  // Motion editor is admin-only for now (hub card + its gating in main.js).
  $('motionHubCard')?.classList.toggle('hidden', !profile || !isAdmin);
}

// ── 랭킹 모달 ───────────────────────────────────────────────
async function openLeaderboard() {
  const modal = $('leaderboardModal');
  const body = $('leaderboardBody');
  if (!modal || !body) return;
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="text-gray-500 text-center py-6 font-mono text-xs">불러오는 중...</div>';

  const rows = await fetchLeaderboard(100);
  if (!rows.length) {
    body.innerHTML = '<div class="text-gray-500 text-center py-6 font-mono text-xs">아직 기록이 없습니다.</div>';
    return;
  }

  const myName = profile?.username;
  body.innerHTML = `
    <table class="w-full font-mono text-xs">
      <thead>
        <tr class="text-[#66fcf1] border-b border-gray-600">
          <th class="text-left py-1 w-10">#</th>
          <th class="text-left py-1">닉네임</th>
          <th class="text-right py-1 w-16">킬</th>
          <th class="text-right py-1 w-16">K/D</th>
          <th class="text-right py-1 w-16">판수</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => {
          const mine = myName && r.username === myName;
          const rankColor = i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-300' : i === 2 ? 'text-amber-600' : 'text-gray-500';
          const deaths = r.total_deaths ?? 0;
          // 사망 0일 땐 나눗셈 대신 킬 수를 그대로 비율로 표기.
          const kd = deaths > 0 ? (r.total_kills / deaths).toFixed(2) : (r.total_kills > 0 ? r.total_kills.toFixed(2) : '0.00');
          return `<tr class="${mine ? 'bg-[#0b3038]' : ''} border-b border-gray-800">
            <td class="py-1 font-bold ${rankColor}">${i + 1}</td>
            <td class="py-1 text-white truncate max-w-[140px]">${escapeHtml(r.username)}${mine ? ' <span class="text-[#45f3ff]">(나)</span>' : ''}</td>
            <td class="py-1 text-right text-[#66fcf1] font-bold">${r.total_kills}</td>
            <td class="py-1 text-right text-gray-300">${kd}</td>
            <td class="py-1 text-right text-gray-400">${r.games_played ?? 0}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ── 상점 모달 (카테고리 탭) ─────────────────────────────────
async function openShop() {
  const modal = $('shopModal');
  const body = $('shopBody');
  if (!modal || !body) return;
  modal.classList.remove('hidden');

  // 비로그인(게스트) → 로그인 유도 (플레이는 로그인 없이도 가능).
  if (!profile) {
    const coinEl = $('shopCoins');
    if (coinEl) coinEl.textContent = '0';
    body.innerHTML = `<div class="col-span-full text-center py-10 font-mono text-sm text-gray-300 leading-relaxed">
      상점은 <span class="text-[#45f3ff]">로그인</span> 후 이용할 수 있어요.<br>
      <span class="text-[11px] text-gray-500">게임 플레이는 로그인 없이도 가능합니다.</span></div>`;
    return;
  }

  // 최신 데이터로 갱신.
  if (!itemCatalog.length) itemCatalog = await fetchItems();
  ownedItemIds = await fetchMyItemIds();
  equipped = await fetchMyEquipped();
  renderShop();
}

// 해당 아이템을 착용 가능한 상태로 보유했는지(무료/구매/업적 해금).
function isOwned(it) {
  if (it.price === 0 && it.unlock_type === 'coin') return true;        // 무료(없음/기본)
  if (it.unlock_type === 'achievement') return (profile?.total_kills || 0) >= it.unlock_threshold;
  return ownedItemIds.has(it.id);
}

function itemSwatch(it) {
  const d = it.data || {};
  if (it.category === 'costume')
    return `<div class="w-12 h-12 rounded-full mb-2 border-2" style="background:${d.color || '#334155'};border-color:${d.accentColor || '#888'}"></div>`;
  if (it.category === 'weaponskin') {
    // Preview the actual skinned weapon sprite (sword as the representative).
    // No skin → base sword. Missing sprite → fall back to a flat tint block.
    const src = d.skin
      ? `/assets/ninja/weapon/skins/${d.skin}/sword.png`
      : `/assets/ninja/weapon/sword.png`;
    const glow = d.tint ? `${d.tint}22` : '#11151c';
    return `<div class="w-12 h-12 mb-2 border-2 border-gray-600 flex items-center justify-center" style="background:${glow}">
      <img src="${src}?v=${ASSET_VERSION}" alt="" class="w-9 h-9" style="image-rendering:pixelated"
onerror="this.style.display='none';this.parentElement.style.background='${d.tint || '#3a4250'}'"></div>`;
  }
  if (it.category === 'title')
    return `<div class="h-12 flex items-center mb-2 font-mono text-xs font-bold" style="color:${d.color || '#9ca3af'}">${escapeHtml(d.text || '없음')}</div>`;
  // killfx / dashtrail / respawnfx → 발광 점
  const col = d.color || '#6b7280';
  return `<div class="w-12 h-12 mb-2 flex items-center justify-center"><div class="w-6 h-6 rounded-full" style="background:${col};box-shadow:0 0 10px ${col}"></div></div>`;
}

function renderItemCard(it) {
  const owned = isOwned(it);
  const isEq = equipped[it.category] === it.id;
  const lockedAch = it.unlock_type === 'achievement' && !owned;
  let btn;
  if (isEq) {
    btn = `<button disabled class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-[#45f3ff] text-[#45f3ff] bg-[#0b3038] cursor-default">착용 중</button>`;
  } else if (owned) {
    btn = `<button data-equip="${it.id}" class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-teal-400 text-teal-300 hover:bg-teal-900/40 cursor-pointer active:scale-95 transition-all">착용하기</button>`;
  } else if (lockedAch) {
    btn = `<button disabled class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-gray-600 text-gray-500 cursor-default">킬 ${it.unlock_threshold} 해금</button>`;
  } else {
    btn = `<button data-buy="${it.id}" class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-yellow-500 text-yellow-300 hover:bg-yellow-900/30 cursor-pointer active:scale-95 transition-all">${Number(it.price).toLocaleString()} 코인 구매</button>`;
  }
  const priceText = it.price === 0
    ? (it.unlock_type === 'achievement' ? `누적 킬 ${it.unlock_threshold}` : '무료')
    : `${Number(it.price).toLocaleString()} 코인`;
  return `
    <div class="bg-[#0b0c10] border-2 border-gray-700 p-3 flex flex-col items-center">
      ${itemSwatch(it)}
      <div class="font-mono text-xs text-white font-bold text-center">${escapeHtml(it.name)}</div>
      <div class="font-mono text-[10px] text-gray-400 mt-0.5">${priceText}</div>
      ${btn}
    </div>`;
}

function renderWeaponSkinTab() {
  const weaponBtns = WEAPON_LIST.map(wpn => {
    const active = wpn === activeSkinWeapon;
    const hasSkin = !!(equipped.weaponskins?.[wpn]);
    const dot = hasSkin ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-[#45f3ff] align-middle"></span>' : '';
    return `<button data-skin-weapon="${wpn}" class="flex items-center justify-between gap-1 px-3 py-2 text-xs font-mono border-2 cursor-pointer transition-all ${active ? 'border-[#45f3ff] text-[#45f3ff] bg-[#0b3038]' : 'border-gray-700 text-gray-300 hover:border-gray-500'}"><span class="truncate">${WEAPON_KO[wpn] || wpn}</span>${dot}</button>`;
  }).join('');

  const wpn = activeSkinWeapon;
  const equippedSkin = equipped.weaponskins?.[wpn] || 'none';

  const skinCards = [
    { id: 'none', name: '기본', price: 0, tint: null },
    ...WEAPON_SKIN_DEFS,
  ].map(sk => {
    const itemId = sk.id === 'none' ? `weaponskin:${wpn}:none` : `weaponskin:${wpn}:${sk.id}`;
    const owned = sk.id === 'none' || ownedItemIds.has(itemId);
    const isEq = equippedSkin === sk.id;
    // crossbow is a shop-only key; its base sprite lives at pistols.png
    const baseFile = wpn === 'crossbow' ? 'pistols' : wpn;
    const src = sk.id === 'none'
      ? `/assets/ninja/weapon/${baseFile}.png`
      : `/assets/ninja/weapon/skins/${sk.id}/${wpn}.png`;
    const glow = sk.tint ? `${sk.tint}22` : '#11151c';
    const preview = `<div class="w-12 h-12 mb-2 border-2 flex items-center justify-center" style="background:${glow};border-color:${isEq ? (sk.tint || '#45f3ff') : '#374151'}">
      <img src="${src}?v=${ASSET_VERSION}" alt="" class="w-9 h-9" style="image-rendering:pixelated"
        onerror="this.style.display='none'"></div>`;
    let btn;
    if (isEq) {
      btn = `<button disabled class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-[#45f3ff] text-[#45f3ff] bg-[#0b3038] cursor-default">착용 중</button>`;
    } else if (owned) {
      btn = `<button data-equip="${itemId}" class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-teal-400 text-teal-300 hover:bg-teal-900/40 cursor-pointer active:scale-95 transition-all">착용하기</button>`;
    } else {
      btn = `<button data-buy="${itemId}" class="w-full mt-2 py-1.5 text-[10px] font-bold uppercase border border-yellow-500 text-yellow-300 hover:bg-yellow-900/30 cursor-pointer active:scale-95 transition-all">${Number(sk.price).toLocaleString()} 코인 구매</button>`;
    }
    return `<div class="bg-[#0b0c10] border-2 border-gray-700 p-3 flex flex-col items-center">
      ${preview}
      <div class="font-mono text-xs text-white font-bold">${sk.name}</div>
      <div class="font-mono text-[10px] text-gray-400 mt-0.5">${sk.id === 'none' ? '무료' : `${Number(sk.price).toLocaleString()} 코인`}</div>
      ${btn}
    </div>`;
  }).join('');

  return `<div class="col-span-full grid grid-cols-2 sm:grid-cols-3 gap-1.5 mb-3">${weaponBtns}</div>
    <div class="col-span-full font-mono text-[11px] text-gray-400 mb-2 mt-1" style="border-top:1px dashed var(--med-wood);padding-top:8px">${WEAPON_KO[wpn] || wpn} 스킨 선택</div>
    ${skinCards}`;
}

function renderShop() {
  const body = $('shopBody');
  const coinEl = $('shopCoins');
  if (!body) return;
  if (coinEl) coinEl.textContent = Number(profile?.coins ?? 0).toLocaleString();

  // 마이그레이션 전(items 없음)이면 레거시 코스튬 카탈로그로 폴백.
  const items = itemCatalog.length
    ? itemCatalog
    : costumeCatalog.map((c) => ({
        id: 'costume:' + c.id, category: 'costume', name: c.name, price: c.price,
        data: { color: c.color, accentColor: c.accent_color }, unlock_type: 'coin',
        unlock_threshold: 0, sort_order: c.sort_order || 0,
      }));

  const cats = SHOP_CATEGORIES.filter((c) => items.some((i) => i.category === c.key));
  const activeCats = cats.length ? cats : SHOP_CATEGORIES.slice(0, 1);
  if (!activeCats.some((c) => c.key === activeCategory)) activeCategory = activeCats[0].key;

  const tabs = activeCats.map((c) => `
    <button data-cat="${c.key}" class="px-2.5 py-1 text-[10px] font-mono uppercase border-2 cursor-pointer active:scale-95 transition-all ${c.key === activeCategory ? 'border-[#45f3ff] text-[#45f3ff] bg-[#0b3038]' : 'border-gray-700 text-gray-400 hover:border-gray-500'}">${c.label}</button>`).join('');

  let content;
  if (activeCategory === 'weaponskin') {
    content = renderWeaponSkinTab();
  } else {
    const catItems = items
      .filter((i) => i.category === activeCategory)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const cards = catItems.map(renderItemCard).join('');
    content = cards || '<div class="col-span-full text-center text-gray-500 text-xs py-6">아이템이 없습니다.</div>';
  }

  body.innerHTML = `
    <div class="col-span-full flex flex-wrap gap-1.5 mb-3">${tabs}</div>
    ${content}`;

  body.querySelectorAll('[data-cat]').forEach((el) =>
    el.addEventListener('click', () => { activeCategory = el.getAttribute('data-cat'); renderShop(); }));
  body.querySelectorAll('[data-skin-weapon]').forEach((el) =>
    el.addEventListener('click', () => { activeSkinWeapon = el.getAttribute('data-skin-weapon'); renderShop(); }));
  body.querySelectorAll('[data-buy]').forEach((el) =>
    el.addEventListener('click', () => handleBuyItem(el.getAttribute('data-buy'))));
  body.querySelectorAll('[data-equip]').forEach((el) =>
    el.addEventListener('click', () => handleEquipItem(el.getAttribute('data-equip'))));
}

async function handleBuyItem(id) {
  try {
    const updated = await purchaseItem(id);
    if (updated) { profile = updated; equipped = equippedFromProfile(updated); }
    ownedItemIds.add(id);
    if (id.startsWith('costume:')) ownedIds.add(id.slice('costume:'.length));
    renderShop();
    renderAccountBar();
  } catch (e) {
    alert(e?.message || '구매에 실패했습니다.');
  }
}

async function handleEquipItem(id) {
  try {
    const updated = await equipItem(id);
    if (updated) { profile = updated; equipped = equippedFromProfile(updated); }
    renderShop();
    renderAccountBar();
    callbacks.onEquip?.();
  } catch (e) {
    alert(e?.message || '착용에 실패했습니다.');
  }
}
