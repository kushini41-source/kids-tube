'use strict';
// 寶貝影片：家長核准頻道，播放器把這些頻道的影片排成一條可以上下切換的清單。

// 改成 https://www.youtube-nocookie.com 會少存 Cookie，但 YouTube Premium 的免廣告可能就不會生效
const PLAYER_HOST = 'https://www.youtube.com';
const API = 'https://www.googleapis.com/youtube/v3/';
const SETTINGS_KEY = 'kidstube.settings.v1';
const POOL_KEY = 'kidstube.pool.v1';
const POOL_TTL = 12 * 60 * 60 * 1000;   // 影片清單 12 小時更新一次
const PAGES_PER_CHANNEL = 4;            // 每個頻道抓最新的 200 部
const SWITCH_COOLDOWN = 450;
const AUTOPLAY_TIMEOUT = 4000;
const MAX_ERROR_STREAK = 12;

const DEFAULTS = {
  apiKey: '',
  channels: (window.DEMO_CHANNELS || []).map(c => ({ id: c.id, title: c.title })),
  videos: [],
  blockedVideos: [],
  blockWords: ['開箱', '整人', '惡作劇', '恐怖', '驚悚', '殭屍', '遊戲實況', 'unboxing', 'prank', 'horror', 'scary', 'gameplay'],
  kidsOnly: true,
  noShorts: true,
};

const $ = id => document.getElementById(id);
const clone = o => JSON.parse(JSON.stringify(o));

let settings = loadSettings();
let pool = [];
let queue = [];
let pos = 0;
let poolDirty = false;
let restartOnClose = false;
let lastPoolError = '';
const bad = new Set();

let player = null;
let playerReady = false;
let unlocked = false;   // 第一次要讓小朋友親手點 YouTube 的播放鍵（iPad 規定），之後才能用按鍵切換
let wasPlaying = false;
let lastDir = 1;
let lastSwitch = 0;
let errorStreak = 0;
let watchdog = 0;
let lockAnswer = 0;

const apiReady = new Promise(resolve => { window.onYouTubeIframeAPIReady = resolve; });

// ---------- 設定 ----------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved) return { ...clone(DEFAULTS), ...saved };
  } catch {}
  return clone(DEFAULTS);
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  poolDirty = true;
}

// ---------- 影片清單 ----------

function titleBlocked(title) {
  const t = (title || '').toLowerCase();
  return settings.blockWords.some(w => w && t.includes(w.toLowerCase()));
}

// 不管清單是剛抓的還是存著的，都再套一次家長的限制
function applyLocalFilters(list) {
  const approved = new Set(settings.channels.map(c => c.id));
  const extra = new Set(settings.videos.map(v => v.id));
  const blocked = new Set(settings.blockedVideos.map(v => v.id));
  const seen = new Set();
  return list.filter(v => {
    if (seen.has(v.id) || blocked.has(v.id)) return false;
    seen.add(v.id);
    if (extra.has(v.id)) return true;   // 家長親自加的影片不套字詞過濾
    return approved.has(v.channelId) && !titleBlocked(v.title);
  });
}

function demoPool() {
  return [...(window.DEMO_VIDEOS || []), ...settings.videos];
}

async function preparePool(force = false) {
  lastPoolError = '';
  if (!settings.apiKey) return applyLocalFilters(demoPool());
  const sig = JSON.stringify([settings.apiKey, settings.channels.map(c => c.id), settings.videos.map(v => v.id), settings.kidsOnly, settings.noShorts]);
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(POOL_KEY)); } catch {}
  if (!force && cached && cached.sig === sig && Date.now() - cached.at < POOL_TTL) return applyLocalFilters(cached.videos);
  try {
    const videos = await buildPoolFromApi();
    try { localStorage.setItem(POOL_KEY, JSON.stringify({ sig, at: Date.now(), videos })); } catch {}
    return applyLocalFilters(videos);
  } catch (e) {
    console.warn(e);
    lastPoolError = e.message;
    if (cached && cached.videos && cached.videos.length) return applyLocalFilters(cached.videos);   // 額度用完時先用舊清單
    return applyLocalFilters(demoPool());
  }
}

async function buildPoolFromApi() {
  const ids = [];
  for (const ch of settings.channels) ids.push(...await channelUploads(ch.id));
  const fromChannels = await videoDetails([...new Set(ids)]);
  const extra = await videoDetails(settings.videos.map(v => v.id));
  return [
    ...fromChannels.filter(v => playable(v) && suitable(v)).map(toItem),
    ...extra.filter(playable).map(toItem),
  ];
}

// UULF 開頭的清單是頻道的「一般影片」，不含 Shorts 和直播
async function channelUploads(channelId) {
  const suffix = channelId.slice(2);
  for (const prefix of settings.noShorts ? ['UULF', 'UU'] : ['UU']) {
    try {
      const ids = [];
      let pageToken = '';
      for (let i = 0; i < PAGES_PER_CHANNEL; i++) {
        const r = await yt('playlistItems', { part: 'contentDetails', playlistId: prefix + suffix, maxResults: 50, pageToken });
        r.items.forEach(it => ids.push(it.contentDetails.videoId));
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      return ids;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return [];
}

async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt('videos', { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    out.push(...r.items);
  }
  return out;
}

function playable(v) {
  const s = v.status || {};
  if (s.embeddable === false) return false;
  if (s.privacyStatus !== 'public' && s.privacyStatus !== 'unlisted') return false;
  return (v.snippet.liveBroadcastContent || 'none') === 'none';
}

function suitable(v) {
  if (settings.kidsOnly && v.status.madeForKids !== true) return false;
  if (settings.noShorts && seconds(v.contentDetails.duration) <= 60) return false;
  return true;
}

function toItem(v) {
  return { id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, channelId: v.snippet.channelId };
}

function seconds(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function yt(endpoint, params) {
  const url = new URL(API + endpoint);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  url.searchParams.set('key', settings.apiKey);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(apiErrorText(data, res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function apiErrorText(data, status) {
  const reason = data && data.error && data.error.errors && data.error.errors[0] ? data.error.errors[0].reason : '';
  if (reason === 'quotaExceeded') return '今天的免費額度用完了，明天會自動恢復。';
  if (reason === 'keyInvalid' || reason === 'badRequest' && status === 400) return 'API 金鑰不正確。';
  if (status === 403) return 'API 金鑰沒有權限：請確認已啟用 YouTube Data API v3，且網址限制有包含這個網站。';
  if (status === 404) return '找不到這個頻道或影片。';
  return (data && data.error && data.error.message) || '連線失敗（' + status + '）';
}

// ---------- 播放順序 ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 每次隨機挑一個頻道再挑一部，避免同一個頻道連續出現太多次
function newRound() {
  const groups = new Map();
  for (const v of pool) {
    if (bad.has(v.id)) continue;
    if (!groups.has(v.channelId)) groups.set(v.channelId, []);
    groups.get(v.channelId).push(v);
  }
  groups.forEach(shuffle);
  const out = [];
  while (groups.size) {
    const keys = [...groups.keys()];
    const key = keys[Math.floor(Math.random() * keys.length)];
    const list = groups.get(key);
    out.push(list.pop());
    if (!list.length) groups.delete(key);
  }
  const last = queue[queue.length - 1];
  if (last && out.length > 1 && out[0].id === last.id) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

function ensureAhead() {
  while (pool.length && queue.length - pos < 4) {
    const round = newRound();
    if (!round.length) break;
    queue.push(...round);
  }
}

function resetQueue() {
  queue = [];
  queue = newRound();
  pos = 0;
  ensureAhead();
}

// ---------- 播放器 ----------

function loadYouTubeApi() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

function createPlayer(videoId) {
  const params = new URLSearchParams({
    enablejsapi: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3,
    fs: 0, disablekb: 1, cc_load_policy: 0, origin: location.origin,
  });
  const iframe = document.createElement('iframe');
  iframe.id = 'player';
  iframe.className = 'player';
  iframe.title = 'YouTube 影片';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.src = `${PLAYER_HOST}/embed/${videoId}?${params}`;
  $('player').replaceWith(iframe);
  showNow(queue[pos]);
  setLocked(true);
  player = new YT.Player(iframe, { events: { onReady, onStateChange, onError } });
}

function onReady() {
  playerReady = true;
}

function onStateChange(e) {
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) {
    clearTimeout(watchdog);
    errorStreak = 0;
    hideCard();
    setPaused(false);
    if (!unlocked) setLocked(false);
  } else if (e.data === S.PAUSED) {
    setPaused(true);
  } else if (e.data === S.ENDED) {
    go(1, true);
  }
}

function onError(e) {
  if (e.data === 153) {
    showMessage('YouTube 拒絕播放（Error 153）。請用「開啟播放器.bat」或網址打開，不要直接雙擊 HTML 檔。');
    return;
  }
  // 影片被刪掉或不能嵌入：從清單拿掉，往同一個方向跳下一部
  const v = queue[pos];
  if (!v) return;
  bad.add(v.id);
  queue.splice(pos, 1);
  if (lastDir < 0) pos = Math.max(0, pos - 1);
  if (++errorStreak > MAX_ERROR_STREAK || !queue.length) {
    showMessage('影片暫時播不了，請爸爸媽媽看一下設定。');
    return;
  }
  ensureAhead();
  showVideo(lastDir);
}

function go(dir, force = false) {
  if (!playerReady || !queue.length) return;
  const now = Date.now();
  if (!force && now - lastSwitch < SWITCH_COOLDOWN) return;
  lastSwitch = now;
  lastDir = dir;
  if (dir < 0 && pos === 0) {
    bump();
    return;
  }
  pos += dir;
  ensureAhead();
  showVideo(dir);
}

function showVideo(dir) {
  const v = queue[pos];
  showCard(v, dir);
  showNow(v);
  setPaused(false);
  player.loadVideoById(v.id);
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    const s = player.getPlayerState();
    // 停在「還沒開始」代表瀏覽器不讓它自己播（iPad 常見），改成讓小朋友點一下
    if (s === YT.PlayerState.UNSTARTED || s === YT.PlayerState.CUED) {
      hideCard();
      setLocked(true);
    }
  }, AUTOPLAY_TIMEOUT);
}

function togglePlay() {
  if (!playerReady) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
}

// ---------- 畫面 ----------

function showCard(v, dir) {
  const card = $('card');
  $('cardImg').src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  card.classList.remove('from-below', 'from-above');
  void card.offsetWidth;   // 讓滑入動畫重新播一次
  card.classList.add('show', dir > 0 ? 'from-below' : 'from-above');
}

function hideCard() {
  $('card').classList.remove('show');
}

function showNow(v) {
  $('now').textContent = v ? v.title : '';
}

function setLocked(locked) {
  unlocked = !locked;
  $('shield').hidden = locked;
  $('holeShield').hidden = !locked;
  $('start').hidden = !locked;
  if (locked) $('paused').hidden = true;
  // 把鍵盤焦點從影片拿回來，上下鍵才有效
  else if ($('parent').hidden) $('kid').focus({ preventScroll: true });
}

function setPaused(paused) {
  $('paused').hidden = !paused || !unlocked;
  $('playBtn').classList.toggle('is-paused', paused);
}

function bump() {
  const screen = $('screen');
  screen.classList.remove('bump');
  void screen.offsetWidth;
  screen.classList.add('bump');
}

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = false;
}

function hideMessage() {
  $('message').hidden = true;
}

// ---------- 操作：鍵盤、滑鼠滾輪、手指滑動 ----------

function bindKidInputs() {
  const kid = $('kid');
  const kidActive = () => $('parent').hidden && !$('lock').open;

  document.addEventListener('keydown', e => {
    if (!kidActive()) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePlay(); }
  });

  // 觸控板一撥會送出一長串滾輪事件，等它停下來才算下一次
  let wheelBusy = false;
  let wheelTimer = 0;
  document.addEventListener('wheel', e => {
    if (!kidActive()) return;
    if (!wheelBusy && Math.abs(e.deltaY) >= 30) {
      go(e.deltaY > 0 ? 1 : -1);
      wheelBusy = true;
    }
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelBusy = false; }, 300);
  }, { passive: true });

  // 手指往上滑＝下一個，跟 Shorts 一樣
  let startX = 0;
  let startY = null;
  kid.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  kid.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  kid.addEventListener('touchend', e => {
    if (startY == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    startY = null;
    if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx)) go(dy < 0 ? 1 : -1);
  });
  kid.addEventListener('contextmenu', e => e.preventDefault());

  $('shield').addEventListener('click', togglePlay);
  $('holeShield').addEventListener('click', togglePlay);   // 電腦上點旁邊也能開始；iPad 還是要點中間
  const press = (id, fn) => $(id).addEventListener('click', () => { fn(); kid.focus({ preventScroll: true }); });
  press('prevBtn', () => go(-1));
  press('nextBtn', () => go(1));
  press('playBtn', togglePlay);
}

// ---------- 家長鎖 ----------

function bindLock() {
  $('parentBtn').addEventListener('click', () => {
    const a = 3 + Math.floor(Math.random() * 7);
    const b = 3 + Math.floor(Math.random() * 7);
    lockAnswer = a * b;
    $('lockQ').textContent = `${a} × ${b} = ?`;
    $('lockA').value = '';
    $('lockErr').hidden = true;
    $('lock').showModal();
    $('lockA').focus();
  });
  $('lockCancel').addEventListener('click', () => $('lock').close());
  $('lockForm').addEventListener('submit', e => {
    e.preventDefault();
    if (Number($('lockA').value) === lockAnswer) {
      $('lock').close();
      openParent();
    } else {
      $('lockErr').hidden = false;
      $('lockA').select();
    }
  });
}

// ---------- 家長設定 ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function openParent() {
  wasPlaying = playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
  if (playerReady) player.pauseVideo();
  $('apiKey').value = settings.apiKey;
  $('keyMsg').hidden = true;
  $('syncOut').hidden = true;
  renderParent();
  $('parent').hidden = false;
  $('parent').scrollTop = 0;
}

async function closeParent() {
  $('parent').hidden = true;
  if (poolDirty || restartOnClose || !player) {
    restartOnClose = false;
    await restart();
  } else if (wasPlaying) {
    player.playVideo();
  }
  $('kid').focus({ preventScroll: true });
}

async function restart() {
  showMessage('正在準備影片…');
  pool = await preparePool();
  poolDirty = false;
  resetQueue();
  if (!queue.length) {
    showMessage('還沒有可以看的影片，請爸爸媽媽到設定加入頻道。');
    return;
  }
  hideMessage();
  if (!player) createPlayer(queue[0].id);
  else showVideo(1);
}

function renderParent() {
  const mode = settings.apiKey
    ? 'API 模式：自動抓核准頻道的影片，每 12 小時更新一次。'
    : '示範模式：還沒有 API 金鑰，只播內建的示範影片。';
  const pending = poolDirty ? '（設定有改，回到播放後會更新）' : '';
  $('modeText').textContent = `${mode} 目前可以播 ${pool.length} 部${pending}。` + (lastPoolError ? ` 注意：${lastPoolError}` : '');

  const cur = queue[pos];
  $('nowCard').hidden = !cur;
  if (cur) {
    $('nowThumb').src = `https://i.ytimg.com/vi/${cur.id}/mqdefault.jpg`;
    $('nowTitle').textContent = cur.title;
    $('nowChannel').textContent = cur.channel || '';
  }

  $('chCount').textContent = `(${settings.channels.length})`;
  renderList('chList', settings.channels, c => [
    el('img', { src: c.thumb || '', alt: '' }),
    el('span', { textContent: c.title }),
    el('button', { class: 'btn small', textContent: '移除', onclick: () => {
      settings.channels = settings.channels.filter(x => x.id !== c.id);
      saveSettings();
      renderParent();
    } }),
  ], '還沒有核准任何頻道');

  $('vCount').textContent = `(${settings.videos.length})`;
  renderList('vList', settings.videos, v => [
    el('img', { class: 'wide', src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '' }),
    el('span', { textContent: v.title }),
    el('button', { class: 'btn small', textContent: '移除', onclick: () => {
      settings.videos = settings.videos.filter(x => x.id !== v.id);
      saveSettings();
      renderParent();
    } }),
  ], '沒有另外加入的影片');

  $('bCount').textContent = `(${settings.blockedVideos.length})`;
  renderList('bList', settings.blockedVideos, v => [
    el('img', { class: 'wide', src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '' }),
    el('span', { textContent: v.title }),
    el('button', { class: 'btn small', textContent: '解除封鎖', onclick: () => {
      settings.blockedVideos = settings.blockedVideos.filter(x => x.id !== v.id);
      saveSettings();
      renderParent();
    } }),
  ], '沒有封鎖的影片');

  $('optKids').checked = settings.kidsOnly;
  $('optShorts').checked = settings.noShorts;
  $('blockWords').value = settings.blockWords.join('、');
}

function renderList(id, items, row, emptyText) {
  const list = $(id);
  list.replaceChildren(...items.map(it => el('li', {}, row(it))));
  if (!items.length) list.append(el('li', { class: 'empty', textContent: emptyText }));
}

function bindParent() {
  $('closeParent').addEventListener('click', closeParent);
  $('fullBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) req.call(root);
    closeParent();
  });

  $('refreshBtn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '抓取中…';
    pool = await preparePool(true);
    poolDirty = false;
    restartOnClose = true;
    btn.disabled = false;
    btn.textContent = '重新抓影片';
    renderParent();
  });

  $('blockNow').addEventListener('click', () => {
    const cur = queue[pos];
    if (!cur || settings.blockedVideos.some(v => v.id === cur.id)) return;
    settings.blockedVideos.push({ id: cur.id, title: cur.title });
    saveSettings();
    restartOnClose = true;
    renderParent();
  });

  $('optKids').addEventListener('change', e => { settings.kidsOnly = e.target.checked; saveSettings(); renderParent(); });
  $('optShorts').addEventListener('change', e => { settings.noShorts = e.target.checked; saveSettings(); renderParent(); });
  $('blockWords').addEventListener('change', e => {
    settings.blockWords = e.target.value.split(/[,，、\n]/).map(w => w.trim()).filter(Boolean);
    saveSettings();
    renderParent();
  });

  $('saveKey').addEventListener('click', () => {
    settings.apiKey = $('apiKey').value.trim();
    saveSettings();
    $('keyMsg').textContent = settings.apiKey ? '已儲存。回到播放後會開始抓核准頻道的影片。' : '已清除金鑰，回到示範模式。';
    $('keyMsg').hidden = false;
    renderParent();
  });

  $('makeSync').addEventListener('click', async () => {
    const data = {
      ...settings,
      channels: settings.channels.map(c => ({ id: c.id, title: c.title })),
    };
    const link = location.href.split('#')[0] + '#setup=' + encodeSetup(data);
    const out = $('syncOut');
    out.value = link;
    out.hidden = false;
    out.select();
    try { await navigator.clipboard.writeText(link); out.value = link; } catch {}
  });

  $('applySync').addEventListener('click', () => {
    if (!$('syncIn').value.trim()) return;
    if (applySetup($('syncIn').value)) {
      $('syncIn').value = '';
      $('apiKey').value = settings.apiKey;
      renderParent();
    }
  });

  $('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    doSearch();
  });
}

// ---------- 搜尋 ----------

async function doSearch() {
  const q = $('searchInput').value.trim();
  const box = $('results');
  if (!q) return;
  if (!settings.apiKey) {
    box.replaceChildren(el('p', { class: 'muted', textContent: '要先在下面填入 YouTube API 金鑰才能搜尋。' }));
    return;
  }
  box.replaceChildren(el('p', { class: 'muted', textContent: '搜尋中…' }));
  const type = document.querySelector('input[name="stype"]:checked').value;
  try {
    const link = parseYouTubeInput(q);
    let items;
    if (link && link.video) items = await videoResults([link.video]);
    else if (link && link.channel) items = await channelResults({ id: link.channel });
    else if (link && link.handle) items = await channelResults({ forHandle: link.handle });
    else {
      const r = await yt('search', {
        part: 'snippet', type, q, maxResults: 12, safeSearch: 'strict', regionCode: 'TW', relevanceLanguage: 'zh-Hant',
        videoEmbeddable: type === 'video' ? 'true' : '',
      });
      items = type === 'channel'
        ? await channelResults({ id: r.items.map(i => i.id.channelId).join(',') })
        : await videoResults(r.items.map(i => i.id.videoId));
    }
    renderResults(items);
  } catch (e) {
    box.replaceChildren(el('p', { class: 'muted', textContent: e.message }));
  }
}

function parseYouTubeInput(s) {
  if (/^@[\w.-]+$/.test(s)) return { handle: s };
  let u;
  try { u = new URL(/^https?:\/\//.test(s) ? s : 'https://' + s); } catch { return null; }
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)) return null;
  if (u.hostname.endsWith('youtu.be')) return { video: u.pathname.slice(1) };
  if (u.searchParams.get('v')) return { video: u.searchParams.get('v') };
  const parts = u.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live'].includes(parts[0]) && parts[1]) return { video: parts[1] };
  if (parts[0] === 'channel' && parts[1]) return { channel: parts[1] };
  if (parts[0] && parts[0].startsWith('@')) return { handle: decodeURIComponent(parts[0]) };
  return null;
}

async function channelResults(params) {
  if (params.id === '') return [];
  const r = await yt('channels', { part: 'snippet,status,statistics', ...params });
  return (r.items || []).map(c => ({
    type: 'channel',
    id: c.id,
    title: c.snippet.title,
    desc: c.snippet.description,
    thumb: c.snippet.thumbnails && c.snippet.thumbnails.default ? c.snippet.thumbnails.default.url : '',
    kids: c.status ? c.status.madeForKids : undefined,
    subs: c.statistics && !c.statistics.hiddenSubscriberCount ? Number(c.statistics.subscriberCount) : 0,
  }));
}

async function videoResults(ids) {
  if (!ids.length) return [];
  const items = await videoDetails(ids);
  return items.map(v => ({
    type: 'video',
    ...toItem(v),
    thumb: v.snippet.thumbnails.medium.url,
    kids: v.status.madeForKids,
    embeddable: v.status.embeddable !== false,
    dur: seconds(v.contentDetails.duration),
  }));
}

function renderResults(items) {
  const box = $('results');
  box.replaceChildren(...items.map(it => it.type === 'channel' ? channelResult(it) : videoResult(it)));
  if (!items.length) box.append(el('p', { class: 'muted', textContent: '找不到結果。' }));
}

function kidsBadge(kids, showWarning) {
  if (kids === true) return el('span', { class: 'badge ok', textContent: '為兒童打造' });
  return showWarning ? el('span', { class: 'badge warn', textContent: '沒有標記為兒童內容' }) : null;
}

function approveChannel(id, title, thumb) {
  if (settings.channels.some(c => c.id === id)) return;
  settings.channels.push({ id, title, thumb: thumb || '' });
  saveSettings();
  renderParent();
}

function doneButton(btn, text) {
  btn.textContent = text;
  btn.disabled = true;
}

function channelResult(c) {
  const approved = settings.channels.some(x => x.id === c.id);
  return el('div', { class: 'result' },
    el('img', { class: 'r-thumb round', src: c.thumb, alt: '' }),
    el('div', {},
      el('p', { class: 'r-title', textContent: c.title }),
      el('p', { class: 'r-meta' }, kidsBadge(c.kids, false), c.subs ? `${formatCount(c.subs)} 位訂閱` : ''),
      c.desc ? el('p', { class: 'r-desc', textContent: c.desc }) : null,
      el('div', { class: 'r-actions' },
        el('button', {
          class: 'btn primary small', textContent: approved ? '已核准' : '核准這個頻道', disabled: approved,
          onclick: e => { approveChannel(c.id, c.title, c.thumb); doneButton(e.currentTarget, '已核准'); },
        }))));
}

function videoResult(v) {
  const added = settings.videos.some(x => x.id === v.id);
  const approved = settings.channels.some(x => x.id === v.channelId);
  return el('div', { class: 'result' },
    el('img', { class: 'r-thumb', src: v.thumb, alt: '' }),
    el('div', {},
      el('p', { class: 'r-title', textContent: v.title }),
      el('p', { class: 'r-meta' }, `${v.channel} · ${formatDuration(v.dur)}`, kidsBadge(v.kids, true),
        v.embeddable ? null : el('span', { class: 'badge warn', textContent: '不能在其他網站播放' })),
      el('div', { class: 'r-actions' },
        el('button', {
          class: 'btn primary small', textContent: added ? '已加入' : '加入這部', disabled: added || !v.embeddable,
          onclick: e => {
            settings.videos.push({ id: v.id, title: v.title, channel: v.channel, channelId: v.channelId });
            saveSettings();
            renderParent();
            doneButton(e.currentTarget, '已加入');
          },
        }),
        el('button', {
          class: 'btn small', textContent: approved ? '頻道已核准' : '核准整個頻道', disabled: approved,
          onclick: e => { approveChannel(v.channelId, v.channel); doneButton(e.currentTarget, '頻道已核准'); },
        }))));
}

function formatCount(n) {
  if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + ' 萬';
  return String(n);
}

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---------- 同步連結 ----------

function encodeSetup(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSetup(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

// 接受整個同步連結，或只有 #setup= 後面那段
function applySetup(text) {
  const m = /#setup=([\w-]+)/.exec(text);
  try {
    const data = decodeSetup(m ? m[1] : text.trim());
    if (!confirm('要套用這組家長設定嗎？這台裝置目前的設定會被取代。')) return false;
    settings = { ...clone(DEFAULTS), ...data };
    saveSettings();
    return true;
  } catch {
    alert('同步連結的格式不正確。');
    return false;
  }
}

function importFromHash() {
  if (!location.hash.startsWith('#setup=')) return;
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  applySetup(hash);
}

// ---------- 開始 ----------

async function start() {
  importFromHash();
  bindKidInputs();
  bindLock();
  bindParent();
  showMessage('正在準備影片…');
  loadYouTubeApi();
  pool = await preparePool();
  poolDirty = false;
  await apiReady;
  resetQueue();
  if (!queue.length) {
    showMessage('還沒有可以看的影片，請爸爸媽媽到設定加入頻道。');
    return;
  }
  hideMessage();
  createPlayer(queue[pos].id);
}

start();
