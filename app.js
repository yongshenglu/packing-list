'use strict';

/* ==================================================================
 * 1. 常量与预置数据
 * ================================================================== */
const APP_NAME = '出游装备';
const LS = { data: 'pl.data', config: 'pl.config', dirty: 'pl.dirty', lastSync: 'pl.lastSync' };
const POOLS = ['essential', 'optional'];
const POOL_LABEL = { essential: '必带', optional: '非必带' };
const SEP = '␟';
const API = 'https://api.github.com';
const SYNC_DEBOUNCE = 5000;

const SEED = {
  essential: ['身份证', '手机充电器', '充电宝', '充电线', '常用药', '雨伞', '纸巾', '湿巾',
    '换洗衣物', '牙刷牙膏', '护肤品', '洗面奶', '现金/银行卡', '耳机', '钥匙', '口罩'],
  optional: ['泳衣', '防晒霜', '墨镜', '保温杯', '零食', '帽子', '拖鞋', '颈枕', '洗漱包']
};

const API_MSG = {
  401: '令牌无效或已过期,请到 GitHub 重新生成',
  403: '请求被 GitHub 拒绝(权限不足或请求过于频繁)',
  404: '不存在或无权访问',
  409: '同步冲突:云端数据已被修改',
  422: '同步冲突:云端数据已被修改'
};

/* ==================================================================
 * 2. 工具函数
 * ================================================================== */
function uuid() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
const nowISO = () => new Date().toISOString();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function formatCNDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${+m[2]}月${+m[3]}日`;
}
function formatStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  const r = document.getElementById('toast-root');
  r.textContent = msg;
  r.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => r.classList.remove('show'), 2400);
}

function showModal(html, opts = {}) {
  document.getElementById('modal-root').innerHTML =
    `<div class="mask"${opts.static ? ' data-static="1"' : ''}><div class="modal">${html}</div></div>`;
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
function confirmDialog(msg, fn) { if (confirm(msg)) fn(); }

/* ==================================================================
 * 3. 状态管理
 * ================================================================== */
const state = {
  data: null,
  config: null,
  dirty: false,
  lastSync: null,
  ui: { route: { name: 'lists' }, poolSearch: '', pick: null, editMode: false }
};

function sanitizeData(d) {
  const now = nowISO();
  const pool = arr => (Array.isArray(arr) ? arr : [])
    .map(it => ({ id: (it && it.id) || uuid(), name: String((it && it.name) || '').trim() }))
    .filter(it => it.name);
  return {
    version: 1,
    updatedAt: d.updatedAt || now,
    pools: {
      essential: pool(d.pools && d.pools.essential),
      optional: pool(d.pools && d.pools.optional)
    },
    templates: (Array.isArray(d.templates) ? d.templates : []).map(t => ({
      id: (t && t.id) || uuid(),
      name: String((t && t.name) || '未命名').trim() || '未命名',
      items: ((t && t.items) || []).map(it => ({
        pool: it && it.pool === 'essential' ? 'essential' : 'optional',
        name: String((it && it.name) || '').trim()
      })).filter(it => it.name),
      createdAt: (t && t.createdAt) || now,
      updatedAt: (t && t.updatedAt) || now
    })),
    lists: (Array.isArray(d.lists) ? d.lists : []).map(l => ({
      id: (l && l.id) || uuid(),
      name: String((l && l.name) || '未命名').trim() || '未命名',
      date: (l && /^\d{4}-\d{2}-\d{2}$/.test(l.date)) ? l.date : null,
      items: ((l && l.items) || []).map(it => ({
        pool: it && it.pool === 'essential' ? 'essential' : 'optional',
        name: String((it && it.name) || '').trim(),
        checked: !!(it && it.checked)
      })).filter(it => it.name),
      fromTemplateId: (l && l.fromTemplateId) || null,
      createdAt: (l && l.createdAt) || now,
      updatedAt: (l && l.updatedAt) || now
    }))
  };
}

function freshData() {
  const d = { version: 1, updatedAt: nowISO(), pools: { essential: [], optional: [] }, templates: [], lists: [] };
  for (const p of POOLS) d.pools[p] = SEED[p].map(name => ({ id: uuid(), name }));
  return d;
}

function persistData() { localStorage.setItem(LS.data, JSON.stringify(state.data)); }
function persistConfig() { localStorage.setItem(LS.config, JSON.stringify(state.config)); }
function persistDirty() { localStorage.setItem(LS.dirty, state.dirty ? '1' : '0'); }
function persistLastSync() { localStorage.setItem(LS.lastSync, JSON.stringify(state.lastSync)); }

function setData(data, opts = {}) {
  state.data = data;
  persistData();
  state.dirty = !!opts.dirty;
  persistDirty();
}

function loadState() {
  let d = null;
  const raw = localStorage.getItem(LS.data);
  if (raw) { try { d = sanitizeData(JSON.parse(raw)); } catch (e) { d = null; } }
  state.data = d || freshData();
  if (!d) persistData();
  try {
    const c = JSON.parse(localStorage.getItem(LS.config) || 'null');
    if (c && c.owner && c.repo) state.config = { owner: c.owner, repo: c.repo, token: c.token || '', autoSync: c.autoSync !== false };
  } catch (e) { /* ignore */ }
  state.dirty = localStorage.getItem(LS.dirty) === '1';
  try {
    const s = JSON.parse(localStorage.getItem(LS.lastSync) || 'null');
    if (s && s.sha) state.lastSync = s;
  } catch (e) { /* ignore */ }
}

function mutate(fn, opts = {}) {
  fn(state.data);
  state.data.updatedAt = nowISO();
  persistData();
  state.dirty = true;
  persistDirty();
  scheduleSync();
  if (opts.render !== false) renderRoute();
}

/* ==================================================================
 * 4. 同步模块
 * ================================================================== */
function syncErr(msg, status) { const e = new Error(msg); if (status) e.status = status; return e; }

const Sync = {
  configured() {
    return !!(state.config && state.config.owner && state.config.repo && state.config.token);
  },
  contentsPath() {
    return `/repos/${encodeURIComponent(state.config.owner)}/${encodeURIComponent(state.config.repo)}/contents/data.json`;
  },
  async api(path, opts = {}) {
    const cfg = state.config || {};
    const headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
    let resp;
    try {
      resp = await fetch(API + path, {
        method: opts.method || 'GET',
        headers,
        cache: opts.method ? 'default' : 'no-store',
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw syncErr('网络不可用,请检查网络连接');
    }
    if (resp.ok) return resp.json();
    throw syncErr(API_MSG[resp.status] || `请求失败(${resp.status})`, resp.status);
  },
  async testRepo() {
    await this.api(`/repos/${encodeURIComponent(state.config.owner)}/${encodeURIComponent(state.config.repo)}`);
  },
  async fetchRemote() {
    let j;
    try { j = await this.api(this.contentsPath()); }
    catch (e) { if (e.status === 404) return { notFound: true }; throw e; }
    if (!j.content) throw syncErr('云端文件过大,无法读取');
    let data;
    try { data = JSON.parse(base64ToUtf8(j.content.replace(/\s+/g, ''))); }
    catch (e) { throw syncErr('云端数据格式异常'); }
    return { sha: j.sha, data: sanitizeData(data) };
  },
  async pushRemote(data, sha) {
    const body = { message: '同步出游装备数据', content: utf8ToBase64(JSON.stringify(data, null, 2)) };
    if (sha) body.sha = sha;
    const j = await this.api(this.contentsPath(), { method: 'PUT', body });
    return { sha: j.content.sha };
  }
};

let syncing = false;
let syncTimer = null;

function scheduleSync() {
  if (!Sync.configured() || !state.config.autoSync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow({ successToast: false, errorToast: true }); }, SYNC_DEBOUNCE);
}

function markSynced(sha) {
  state.lastSync = { time: nowISO(), sha };
  persistLastSync();
  state.dirty = false;
  persistDirty();
}

function patchSyncRow() {
  const el = document.getElementById('ls-text');
  if (el) el.textContent = lastSyncText();
}

function lastSyncText() {
  if (!Sync.configured()) return '当前为仅本地模式,数据只保存在本机';
  if (!state.lastSync) return '尚未同步过';
  return `上次同步:${formatStamp(state.lastSync.time)}` + (state.dirty ? '(有未同步修改)' : '');
}

async function syncNow(opts = {}) {
  if (!Sync.configured() || syncing) return;
  syncing = true;
  setSyncBtnBusy(true);
  try {
    const remote = await Sync.fetchRemote();
    if (remote.notFound) {
      const r = await Sync.pushRemote(state.data, undefined);
      markSynced(r.sha);
      if (opts.successToast) toast('同步成功,云端已创建数据');
    } else if (state.dirty) {
      const known = state.lastSync && state.lastSync.sha;
      if (known && remote.sha === known) {
        const r = await Sync.pushRemote(state.data, remote.sha);
        markSynced(r.sha);
        if (opts.successToast) toast('同步成功');
      } else {
        if (opts.errorToast) toast('本地与云端都有修改,需要处理冲突');
        showConflict(remote);
      }
    } else {
      setData(remote.data, { dirty: false });
      markSynced(remote.sha);
      if (opts.successToast) toast('已同步云端数据');
      renderRoute();
    }
    patchSyncRow();
  } catch (e) {
    if (opts.errorToast) toast(e.message);
  } finally {
    syncing = false;
    setSyncBtnBusy(false);
  }
}

function setSyncBtnBusy(busy) {
  const btn = document.querySelector('[data-action="st-sync"]');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? '同步中…' : '立即同步';
}

function showConflict(remote) {
  showModal(`<div class="modal-card"><h3>同步冲突</h3>
    <p class="muted">云端数据已被修改,而本地也有未同步的修改。请选择保留哪一份。</p>
    <div class="mrow col">
      <button class="btn primary block" data-action="cf-overwrite">用本地覆盖云端</button>
      <button class="btn block" data-action="cf-adopt">加载云端(放弃本地修改)</button>
      <button class="btn ghost block" data-action="close-modal">稍后再说</button>
    </div></div>`, { static: true });
}

/* ==================================================================
 * 5. 路由
 * ================================================================== */
function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/lists';
  const [pathPart, query] = h.split('?');
  const seg = pathPart.split('/').filter(Boolean);
  if (seg[0] === 'list') return { name: 'list', id: seg[1] || '' };
  if (seg[0] === 'pick') return { name: 'pick', target: new URLSearchParams(query || '').get('target') || '' };
  if (seg[0] === 'pools') return { name: 'pools' };
  if (seg[0] === 'templates') return { name: 'templates' };
  if (seg[0] === 'template') return { name: 'template', id: seg[1] || '' };
  if (seg[0] === 'settings') return { name: 'settings' };
  return { name: 'lists' };
}

function getList(id, data) {
  const d = data || state.data;
  return d.lists.find(l => l.id === id);
}
function getTemplate(id, data) {
  const d = data || state.data;
  return d.templates.find(t => t.id === id);
}
function sortItems(items) {
  return [...items.filter(i => i.pool === 'essential'), ...items.filter(i => i.pool === 'optional')];
}

function renderRoute() {
  const r = parseRoute();
  state.ui.route = r;
  if (r.name === 'lists' || r.name === 'pools' || r.name === 'templates' || r.name === 'settings') {
    state.ui.editMode = false;
  }
  closeModal();

  let html = '', title = APP_NAME, back = false, action = '';
  switch (r.name) {
    case 'lists': {
      const v = vLists(); html = v.html; action = v.action || ''; title = '出游清单'; break;
    }
    case 'list': {
      const l = getList(r.id);
      if (!l) { location.hash = '#/lists'; return; }
      const v = vListDetail(l); html = v.html; action = v.action || ''; title = l.name; back = true; break;
    }
    case 'pick': {
      initPick(r.target);
      html = vPick(); title = '选择物品'; back = true; break;
    }
    case 'pools': title = '物品池'; html = vPools(); break;
    case 'templates': {
      const v = vTemplates(); html = v.html; action = v.action || ''; title = '模版'; break;
    }
    case 'template': {
      const t = getTemplate(r.id);
      if (!t) { location.hash = '#/templates'; return; }
      html = vTemplateDetail(t); title = t.name; back = true; break;
    }
    case 'settings': title = '设置'; html = vSettings(); break;
  }

  document.getElementById('page-title').textContent = title;
  document.getElementById('btn-back').hidden = !back;
  document.getElementById('topbar-action').innerHTML = action;

  const navKey = r.name === 'list' || (r.name === 'pick' && r.target.startsWith('list:')) ? 'lists'
    : r.name === 'template' || (r.name === 'pick' && r.target.startsWith('template:')) ? 'templates'
    : POOLS.includes(r.name) || r.name === 'settings' ? r.name : 'lists';
  document.querySelectorAll('#tabbar button').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === navKey));

  const view = document.getElementById('view');
  view.innerHTML = html;
  view.scrollTop = 0;
}

function goBack() {
  const r = state.ui.route;
  if (r.name === 'list') location.hash = '#/lists';
  else if (r.name === 'template') location.hash = '#/templates';
  else if (r.name === 'pick') {
    const t = r.target;
    if (t.startsWith('list:')) location.hash = '#/list/' + t.slice(5);
    else if (t.startsWith('template:')) location.hash = '#/template/' + t.slice(9);
    else location.hash = '#/lists';
  } else location.hash = '#/lists';
}

/* ==================================================================
 * 6. 视图渲染
 * ================================================================== */
const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const CASE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';

function poolTag(pool) {
  return `<div class="tag tag-${pool}"><i class="hole"></i>${POOL_LABEL[pool]}</div>`;
}

function progressOf(l) {
  const total = l.items.length;
  const done = l.items.filter(i => i.checked).length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0, complete: total > 0 && done === total };
}

function vLists() {
  const lists = [...state.data.lists].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const rows = lists.map(l => {
    const p = progressOf(l);
    return `<button class="row" data-action="open-list" data-id="${l.id}">
      <div class="row-main">
        <div class="row-title">${escapeHtml(l.name)}</div>
        <div class="row-sub">${l.date ? `<span class="row-date">${formatCNDate(l.date)}出发</span>` : ''}<span>已打包 ${p.done} / ${p.total}</span></div>
        <div class="bar"><i style="width:${p.pct}%"></i></div>
      </div><span class="chev">›</span></button>`;
  }).join('');
  const html = lists.length
    ? `<div class="card">${rows}</div>`
    : `<div class="empty">${CASE_SVG}<p>还没有清单,准备下一次出行吧</p><button class="btn primary" data-action="new-list">新建清单</button></div>`;
  return { html, action: '<button class="tbtn" data-action="new-list">＋ 新建</button>' };
}

function vListDetail(l) {
  const p = progressOf(l);
  const rows = l.items.map((it, idx) => {
    const del = state.ui.editMode
      ? `<button class="icon-btn del" data-action="list-del-item" data-idx="${idx}" aria-label="删除${escapeHtml(it.name)}">${TRASH_SVG}</button>` : '';
    return `<div class="check-row${it.checked ? ' done' : ''}">
      <label class="chk"><input type="checkbox" data-check="list" data-idx="${idx}"${it.checked ? ' checked' : ''}><span class="box">${CHECK_SVG}</span><span class="chk-name">${escapeHtml(it.name)}</span></label>${del}</div>`;
  }).join('');

  const body = l.items.length
    ? `<div class="card">${rows}</div>`
    : `<div class="empty">${CASE_SVG}<p>清单还是空的</p><button class="btn primary" data-action="open-picker" data-target="list:${l.id}">从物品池选择</button></div>`;

  const html = `
    <div class="prog${p.complete ? ' complete' : ''}">
      <div class="prog-top"><span class="prog-num"><b id="lp-done">${p.done}</b> / <span id="lp-total">${p.total}</span></span><span class="prog-label" id="lp-label">${p.complete ? '全部打包完成' : '已打包'}</span></div>
      <div class="bar"><i id="lp-bar" style="width:${p.pct}%"></i></div>
      <button class="date-link" data-action="edit-date" data-id="${l.id}">${l.date ? formatCNDate(l.date) + '出发 · 点击修改' : '设置出发日期'}</button>
    </div>
    ${body}
    <div class="stick-bottom">
      <div class="addrow"><input id="quick-add" type="text" placeholder="添加物品(只进清单,不动物品池)"><button class="btn" data-action="quick-add">添加</button></div>
      ${l.items.length ? `<button class="btn block" data-action="open-picker" data-target="list:${l.id}">从物品池选择</button>` : ''}
    </div>`;
  return { html, action: `<button class="tbtn" data-action="list-menu" data-id="${l.id}" aria-label="更多操作">⋯</button>` };
}

function vPools() {
  return `<div class="search"><input id="pool-search" type="search" placeholder="搜索物品" value="${escapeHtml(state.ui.poolSearch)}"></div>
    <div id="pool-results">${poolResultsHTML()}</div>`;
}

function poolResultsHTML() {
  const q = state.ui.poolSearch.trim().toLowerCase();
  let out = '';
  for (const pool of POOLS) {
    const items = state.data.pools[pool].filter(it => !q || it.name.toLowerCase().includes(q));
    if (!items.length && q) continue;
    const rows = items.map(it =>
      `<div class="prow"><button class="prow-name" data-action="pool-rename" data-pool="${pool}" data-id="${it.id}">${escapeHtml(it.name)}</button>
       <button class="icon-btn del" data-action="pool-del" data-pool="${pool}" data-id="${it.id}" aria-label="删除${escapeHtml(it.name)}">${TRASH_SVG}</button></div>`).join('');
    const addRow = `<div class="addrow"><input type="text" placeholder="添加${POOL_LABEL[pool]}物品" data-add-pool="${pool}"><button class="btn" data-action="pool-add" data-pool="${pool}">添加</button></div>`;
    out += poolTag(pool) + `<div class="card">${rows || '<div class="empty" style="padding:24px"><p>物品池为空,在下方添加</p></div>'}${addRow}</div>`;
  }
  if (q && !out) out = `<div class="empty"><p>未找到匹配物品</p></div>`;
  return out;
}

function vTemplates() {
  const tpls = [...state.data.templates].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const rows = tpls.map(t =>
    `<button class="row" data-action="open-template" data-id="${t.id}">
      <div class="row-main"><div class="row-title">${escapeHtml(t.name)}</div><div class="row-sub"><span>${t.items.length} 件物品</span></div></div>
      <span class="chev">›</span></button>`).join('');
  const html = tpls.length
    ? `<div class="card">${rows}</div>`
    : `<div class="empty">${CASE_SVG}<p>还没有模版<br>在清单的「⋯」菜单里可把清单保存为模版</p><button class="btn primary" data-action="new-template">新建模版</button></div>`;
  return { html, action: '<button class="tbtn" data-action="new-template">＋ 新建</button>' };
}

function vTemplateDetail(t) {
  const groups = POOLS.map(pool => {
    const idxs = [];
    t.items.forEach((it, idx) => { if (it.pool === pool) idxs.push(idx); });
    if (!idxs.length) return '';
    const rows = idxs.map(idx =>
      `<div class="prow"><span class="prow-name" style="padding-right:8px">${escapeHtml(t.items[idx].name)}</span>
       <button class="icon-btn del" data-action="tpl-del-item" data-idx="${idx}" aria-label="删除${escapeHtml(t.items[idx].name)}">${TRASH_SVG}</button></div>`).join('');
    return poolTag(pool) + `<div class="card">${rows}</div>`;
  }).join('');
  return `
    <div class="card pad" style="margin-top:10px"><div class="setrow"><span>模版名称</span><button class="tbtn" data-action="tpl-rename" data-id="${t.id}">重命名</button></div></div>
    ${t.items.length ? groups : `<div class="empty">${CASE_SVG}<p>模版还没有物品</p></div>`}
    <div class="stick-bottom">
      <button class="btn block" data-action="open-picker" data-target="template:${t.id}">添加物品</button>
      <button class="btn primary block" data-action="tpl-new-list" data-id="${t.id}">用此模版创建清单</button>
      <button class="btn danger block" data-action="tpl-del" data-id="${t.id}">删除模版</button>
    </div>`;
}

function initPick(target) {
  if (state.ui.pick && state.ui.pick.target === target) return;
  const initial = new Set();
  if (target.startsWith('list:')) {
    const l = getList(target.slice(5));
    if (l) l.items.forEach(it => initial.add(it.pool + SEP + it.name));
  } else if (target.startsWith('template:')) {
    const t = getTemplate(target.slice(9));
    if (t) t.items.forEach(it => initial.add(it.pool + SEP + it.name));
  }
  state.ui.pick = { target, initial, selected: new Set(initial), search: '' };
}

function vPick() {
  const p = state.ui.pick;
  return `<div class="search"><input id="pick-search" type="search" placeholder="搜索物品" value="${escapeHtml(p.search)}"></div>
    <div id="pick-results">${pickResultsHTML()}</div>
    <div class="stick-bottom"><button class="btn primary block" data-action="pick-confirm">确定(已选 <span id="pick-count">${p.selected.size}</span> 件)</button></div>`;
}

function pickResultsHTML() {
  const p = state.ui.pick;
  const q = p.search.trim().toLowerCase();
  let out = '';
  for (const pool of POOLS) {
    const items = state.data.pools[pool].filter(it => !q || it.name.toLowerCase().includes(q));
    if (!items.length) continue;
    const rows = items.map(it => {
      const k = pool + SEP + it.name;
      return `<label class="chk"><input type="checkbox" data-check="pick" data-key="${escapeHtml(k)}"${p.selected.has(k) ? ' checked' : ''}><span class="box">${CHECK_SVG}</span><span class="chk-name">${escapeHtml(it.name)}</span></label>`;
    }).join('');
    out += poolTag(pool) + `<div class="card">${rows}</div>`;
  }
  if (!out) out = `<div class="empty"><p>${q ? '未找到匹配物品' : '物品池为空,请先到「物品池」添加物品'}</p></div>`;
  return out;
}

function applyPickToList(l, p) {
  const keyOf = it => it.pool + SEP + it.name;
  let items = l.items.filter(it => !(p.initial.has(keyOf(it)) && !p.selected.has(keyOf(it))));
  for (const k of p.selected) {
    if (!items.some(it => keyOf(it) === k)) {
      const i = k.indexOf(SEP);
      items.push({ pool: k.slice(0, i), name: k.slice(i + 1), checked: false });
    }
  }
  l.items = items;
}

function vSettings() {
  const c = state.config || { owner: '', repo: 'packing-list-data', token: '', autoSync: true };
  const configured = Sync.configured();
  return `
    ${configured ? '' : `<div class="banner" style="margin-top:10px">当前为<b>仅本地模式</b>:数据只保存在本机浏览器,换设备或清除浏览器数据会丢失。配置 GitHub 私有仓库后可多设备同步。</div>`}
    <div class="sec-title">GitHub 同步</div>
    <div class="card pad">
      <label class="fld">GitHub 用户名<input id="st-owner" type="text" value="${escapeHtml(c.owner || '')}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
      <label class="fld">数据仓库名(需为私有仓库)<input id="st-repo" type="text" value="${escapeHtml(c.repo || '')}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
      <label class="fld">访问令牌(PAT)<span class="tokwrap"><input id="st-token" type="password" value="${escapeHtml(c.token || '')}" autocomplete="off" spellcheck="false"><button class="tok-btn" data-action="st-token-toggle">显示</button></span></label>
      <div class="btnrow">
        <button class="btn" data-action="st-test" style="flex:1">测试连接</button>
        <button class="btn primary" data-action="st-save" style="flex:1">保存配置</button>
      </div>
      <div id="test-result" class="test-result"></div>
      <div class="setrow"><span>自动同步<small style="display:block;color:var(--ink-2);font-size:12px">改动后约 5 秒自动推送到云端</small></span>
        <label class="switch"><input type="checkbox" data-check="autosync"${(c.autoSync !== false && configured) ? ' checked' : ''}${configured ? '' : ' disabled'}><span class="knob"></span></label></div>
      <button class="btn primary block ${configured ? '' : 'dis'}" data-action="st-sync" style="margin-top:10px"${configured ? '' : ' disabled'}>立即同步</button>
      <div class="ls-row" id="ls-text">${escapeHtml(lastSyncText())}</div>
    </div>
    <div class="sec-title">如何获取令牌(首次配置需一次)</div>
    <details class="card pad howto"><summary>点此查看步骤</summary><ol>
      <li>在手机或电脑浏览器打开 github.com 并登录</li>
      <li>右上角头像 → Settings(设置)</li>
      <li>左栏最底部 → Developer settings(开发者设置)</li>
      <li>Personal access tokens → Fine-grained tokens → Generate new token</li>
      <li>名称随意(如「出游装备」),有效期尽量选长(到期后需重新生成并更新到这里)</li>
      <li>Repository access 选 <b>Only select repositories</b>,勾选数据仓库 <b>${escapeHtml(c.repo || 'packing-list-data')}</b></li>
      <li>Permissions 中将 <b>Contents</b> 设为 <b>Read and write</b></li>
      <li>点 Generate token,复制以 <b>github_pat_</b> 开头的令牌,粘贴到上方「访问令牌」框</li>
    </ol></details>
    <div class="sec-title">备份</div>
    <div class="card pad btnrow col">
      <button class="btn block" data-action="st-export">导出 JSON 备份</button>
      <button class="btn block" data-action="st-import">导入 JSON 备份</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>
    <div class="sec-title">其他</div>
    <div class="card pad btnrow col">
      <button class="btn block" data-action="st-seed">恢复预置物品</button>
      <button class="btn danger block" data-action="st-clear">清除本地数据</button>
    </div>
    <div class="sec-title">隐私说明</div>
    <p class="privacy">访问令牌只保存在本机浏览器中,仅用于访问你自己的私有数据仓库,不会发送到 GitHub 以外的任何服务器。本应用不加载任何第三方代码,不收集任何统计数据。清除浏览器数据或点「清除本地数据」即可删除令牌。</p>`;
}

/* ==================================================================
 * 7. 事件处理
 * ================================================================== */
function readConfigForm() {
  return {
    owner: (document.getElementById('st-owner').value || '').trim(),
    repo: (document.getElementById('st-repo').value || '').trim(),
    token: (document.getElementById('st-token').value || '').trim()
  };
}

function doQuickAdd() {
  const r = state.ui.route;
  if (r.name !== 'list') return;
  const input = document.getElementById('quick-add');
  const name = (input.value || '').trim();
  if (!name) return;
  const pool = POOLS.find(pl => state.data.pools[pl].some(it => it.name === name)) || 'optional';
  const l = getList(r.id);
  if (l.items.some(it => it.pool === pool && it.name === name)) { toast('该物品已在清单中'); return; }
  mutate(d => {
    const li = getList(r.id, d);
    li.items.push({ pool, name, checked: false });
    li.updatedAt = nowISO();
  });
  const el = document.getElementById('quick-add');
  if (el) el.focus();
}

function doPoolAdd(pool) {
  const input = document.querySelector(`[data-add-pool="${pool}"]`);
  const name = (input && input.value || '').trim();
  if (!name) return;
  if (state.data.pools[pool].some(it => it.name === name)) { toast('该物品已存在'); return; }
  mutate(d => { d.pools[pool].push({ id: uuid(), name }); });
}

function doNewListCreate() {
  const nameEl = document.getElementById('nl-name');
  if (!nameEl) return;
  const name = (nameEl.value || '').trim() || '我的行程';
  const date = (document.getElementById('nl-date').value || '') || null;
  const tid = document.getElementById('nl-template').value;
  const t = tid ? getTemplate(tid) : null;
  const items = t ? t.items.map(it => ({ pool: it.pool, name: it.name, checked: false })) : [];
  const id = uuid(), now = nowISO();
  mutate(d => { d.lists.push({ id, name, date, items, fromTemplateId: t ? t.id : null, createdAt: now, updatedAt: now }); });
  closeModal();
  location.hash = '#/list/' + id;
  if (t) toast(`已从模版「${t.name}」创建`);
}

function showNewList(preTplId, preName) {
  const opts = state.data.templates.map(t =>
    `<option value="${t.id}"${t.id === preTplId ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
  showModal(`<div class="modal-card"><h3>新建清单</h3>
    <label class="fld">名称<input id="nl-name" type="text" placeholder="如:五一杭州游" value="${escapeHtml(preName || '')}"></label>
    <label class="fld">出发日期(可选)<input id="nl-date" type="date"></label>
    <label class="fld">从模版创建(可选)<select id="nl-template"><option value="">不使用模版</option>${opts}</select></label>
    <div class="mrow"><button class="btn ghost" data-action="close-modal">取消</button><button class="btn primary" data-action="nl-create">创建</button></div></div>`);
  setTimeout(() => { const el = document.getElementById('nl-name'); if (el) el.focus(); }, 50);
}

function showListMenu(l) {
  showModal(`<div class="sheet">
    <button class="sheet-btn" data-action="save-as-template" data-id="${l.id}">保存为模版</button>
    <button class="sheet-btn" data-action="edit-date" data-id="${l.id}">修改日期</button>
    <button class="sheet-btn danger" data-action="delete-list" data-id="${l.id}">删除清单</button>
    <button class="sheet-btn cancel" data-action="close-modal">取消</button></div>`);
}

function showEditDate(l) {
  showModal(`<div class="modal-card"><h3>出发日期</h3>
    <label class="fld">留空表示不设日期<input id="ed-date" type="date" value="${escapeHtml(l.date || '')}"></label>
    <div class="mrow"><button class="btn ghost" data-action="close-modal">取消</button><button class="btn primary" data-action="ed-save" data-id="${l.id}">保存</button></div></div>`);
}

function refreshListProgressDOM(l) {
  const p = progressOf(l);
  const done = document.getElementById('lp-done');
  if (!done) return;
  done.textContent = p.done;
  document.getElementById('lp-total').textContent = p.total;
  document.getElementById('lp-bar').style.width = p.pct + '%';
  document.getElementById('lp-label').textContent = p.complete ? '全部打包完成' : '已打包';
  const prog = document.querySelector('.prog');
  if (prog) prog.classList.toggle('complete', p.complete);
}

function doPickConfirm() {
  const p = state.ui.pick;
  if (!p) return;
  const t = p.target;
  if (t.startsWith('list:')) {
    mutate(d => { const l = getList(t.slice(5), d); applyPickToList(l, p); l.updatedAt = nowISO(); });
    location.hash = '#/list/' + t.slice(5);
  } else if (t.startsWith('template:')) {    mutate(d => {
      const tp = getTemplate(t.slice(9), d);
      const items = [...p.selected].map(k => { const i = k.indexOf(SEP); return { pool: k.slice(0, i), name: k.slice(i + 1) }; });
      tp.items = sortItems(items);
      tp.updatedAt = nowISO();
    });
    location.hash = '#/template/' + t.slice(9);
  } else { goBack(); return; }
  state.ui.pick = null;
  toast('已保存');
}

async function handleTestConnection() {
  const el = document.getElementById('test-result');
  const form = readConfigForm();
  if (!form.owner || !form.repo || !form.token) {
    el.innerHTML = '<span class="err">请先填写用户名、仓库名和令牌</span>';
    return;
  }
  el.textContent = '测试中…';
  const saved = state.config;
  state.config = { ...form, autoSync: true };
  try {
    await Sync.testRepo();
    el.innerHTML = '<span class="ok">连接成功,仓库可访问</span>';
  } catch (e) {
    const msg = e.status === 404 ? '仓库不存在或令牌无权访问,请检查仓库名和令牌权限' : e.message;
    el.innerHTML = `<span class="err">${escapeHtml(msg)}</span>`;
  } finally {
    state.config = saved;
  }
}

function handleImportFile(inputEl) {
  const f = inputEl.files && inputEl.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = sanitizeData(JSON.parse(reader.result));
      confirmDialog('导入将覆盖当前数据,确定?', () => {
        setData(d, { dirty: true });
        scheduleSync();
        renderRoute();
        toast('导入成功');
      });
    } catch (e) {
      toast('文件格式不正确,导入失败');
    } finally {
      inputEl.value = '';
    }
  };
  reader.readAsText(f);
}

async function conflictOverwrite() {
  try {
    const remote = await Sync.fetchRemote();
    const r = await Sync.pushRemote(state.data, remote.notFound ? undefined : remote.sha);
    markSynced(r.sha);
    closeModal();
    toast('已用本地数据覆盖云端');
    patchSyncRow();
  } catch (e) { toast(e.message); }
}

async function conflictAdopt() {
  const doAdopt = async () => {
    try {
      const remote = await Sync.fetchRemote();
      if (remote.notFound) { toast('云端暂无数据'); return; }
      setData(remote.data, { dirty: false });
      markSynced(remote.sha);
      closeModal();
      renderRoute();
      toast('已加载云端数据');
    } catch (e) { toast(e.message); }
  };
  if (state.dirty) confirmDialog('将放弃本地未同步的修改,确定?', doAdopt);
  else doAdopt();
}

function restoreSeed() {
  let n = 0;
  mutate(d => {
    for (const pool of POOLS) {
      for (const name of SEED[pool]) {
        if (!d.pools[pool].some(it => it.name === name)) { d.pools[pool].push({ id: uuid(), name }); n++; }
      }
    }
  });
  toast(n ? `已恢复 ${n} 件预置物品` : '预置物品都已存在');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  a.download = `出游装备备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('已导出备份文件');
}

document.addEventListener('click', e => {
  const mask = e.target.classList && e.target.classList.contains('mask');
  if (mask) {
    if (!e.target.dataset.static) closeModal();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;

  switch (a) {
    case 'tab': location.hash = '#/' + el.dataset.tab; break;
    case 'back': goBack(); break;
    case 'close-modal': closeModal(); break;

    case 'new-list': showNewList(); break;
    case 'nl-create': doNewListCreate(); break;
    case 'open-list': location.hash = '#/list/' + id; break;
    case 'list-menu': { const l = getList(id); if (l) showListMenu(l); break; }
    case 'save-as-template': {
      const l = getList(id);
      if (!l) break;
      const name = prompt('模版名称', l.name);
      if (name === null) break;
      const n = name.trim() || l.name;
      const now = nowISO();
      mutate(d => {
        d.templates.push({ id: uuid(), name: n, items: l.items.map(it => ({ pool: it.pool, name: it.name })), createdAt: now, updatedAt: now });
      });
      closeModal();
      toast('已保存为模版');
      break;
    }
    case 'edit-date': { const l = getList(id); if (l) showEditDate(l); break; }
    case 'ed-save': {
      const date = (document.getElementById('ed-date').value || '') || null;
      mutate(d => { const l = getList(id, d); if (l) { l.date = date; l.updatedAt = nowISO(); } });
      closeModal();
      break;
    }
    case 'delete-list': {
      const l = getList(id);
      if (!l) break;
      confirmDialog(`删除清单「${l.name}」?物品池和模版不受影响。`, () => {
        mutate(d => { d.lists = d.lists.filter(x => x.id !== id); });
        closeModal();
        location.hash = '#/lists';
      });
      break;
    }
    case 'list-del-item': {
      const r = state.ui.route;
      const l = getList(r.id);
      if (!l) break;
      const it = l.items[+el.dataset.idx];
      if (!it) break;
      confirmDialog(`从清单中删除「${it.name}」?`, () => {
        mutate(d => { const li = getList(r.id, d); li.items.splice(+el.dataset.idx, 1); li.updatedAt = nowISO(); });
      });
      break;
    }
    case 'quick-add': doQuickAdd(); break;
    case 'open-picker': location.hash = '#/pick?target=' + encodeURIComponent(el.dataset.target); break;
    case 'pick-confirm': doPickConfirm(); break;

    case 'pool-add': doPoolAdd(el.dataset.pool); break;
    case 'pool-rename': {
      const pool = el.dataset.pool;
      const it = state.data.pools[pool].find(x => x.id === id);
      if (!it) break;
      const name = prompt('重命名物品', it.name);
      if (name === null) break;
      const n = name.trim();
      if (!n || n === it.name) break;
      if (state.data.pools[pool].some(x => x.id !== id && x.name === n)) { toast('该物品已存在'); break; }
      mutate(d => { const t = d.pools[pool].find(x => x.id === id); if (t) t.name = n; });
      break;
    }
    case 'pool-del': {
      const pool = el.dataset.pool;
      const it = state.data.pools[pool].find(x => x.id === id);
      if (!it) break;
      confirmDialog(`删除物品「${it.name}」?已有清单和模版不受影响。`, () => {
        mutate(d => { d.pools[pool] = d.pools[pool].filter(x => x.id !== id); });
      });
      break;
    }

    case 'new-template': {
      const name = prompt('模版名称');
      if (name === null) break;
      const n = name.trim();
      if (!n) { toast('名称不能为空'); break; }
      const id2 = uuid(), now = nowISO();
      mutate(d => { d.templates.push({ id: id2, name: n, items: [], createdAt: now, updatedAt: now }); });
      location.hash = '#/template/' + id2;
      break;
    }
    case 'open-template': location.hash = '#/template/' + id; break;
    case 'tpl-rename': {
      const t = getTemplate(id);
      if (!t) break;
      const name = prompt('重命名模版', t.name);
      if (name === null) break;
      const n = name.trim();
      if (!n || n === t.name) break;
      mutate(d => { const x = getTemplate(id, d); if (x) { x.name = n; x.updatedAt = nowISO(); } });
      break;
    }
    case 'tpl-del-item': {
      const r = state.ui.route;
      confirmDialog('从模版中删除该物品?', () => {
        mutate(d => { const t = getTemplate(r.id, d); if (t) { t.items.splice(+el.dataset.idx, 1); t.updatedAt = nowISO(); } });
      });
      break;
    }
    case 'tpl-new-list': {
      const t = getTemplate(id);
      if (t) showNewList(t.id, t.name);
      break;
    }
    case 'tpl-del': {
      const t = getTemplate(id);
      if (!t) break;
      confirmDialog(`删除模版「${t.name}」?已创建的清单不受影响。`, () => {
        mutate(d => { d.templates = d.templates.filter(x => x.id !== id); });
        location.hash = '#/templates';
      });
      break;
    }

    case 'st-test': handleTestConnection(); break;
    case 'st-save': {
      const form = readConfigForm();
      if (!form.owner || !form.repo || !form.token) { toast('请填写完整:用户名、仓库名和令牌'); break; }
      if (/[\s/]/.test(form.repo)) { toast('仓库名不能包含空格或斜杠'); break; }
      state.config = { ...form, autoSync: state.config ? state.config.autoSync !== false : true };
      persistConfig();
      toast('配置已保存');
      renderRoute();
      break;
    }
    case 'st-token-toggle': {
      const inp = document.getElementById('st-token');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      el.textContent = show ? '隐藏' : '显示';
      break;
    }
    case 'st-sync': syncNow({ successToast: true, errorToast: true }); break;
    case 'st-export': exportJson(); break;
    case 'st-import': document.getElementById('import-file').click(); break;
    case 'st-seed': restoreSeed(); break;
    case 'st-clear': {
      confirmDialog('将清除本机的物品池、清单和模版,恢复为预置物品。云端数据不会删除;若已配置同步,下次同步会从云端恢复。确定?', () =>
        confirmDialog('再次确认:清除本机数据?', () => {
          localStorage.removeItem(LS.data);
          localStorage.removeItem(LS.dirty);
          setData(freshData(), { dirty: false });
          renderRoute();
          toast('已清除本地数据');
        }));
      break;
    }

    case 'cf-overwrite': conflictOverwrite(); break;
    case 'cf-adopt': conflictAdopt(); break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-check="list"]')) {
    const r = state.ui.route;
    const idx = +t.dataset.idx;
    mutate(d => {
      const l = getList(r.id, d);
      if (l && l.items[idx]) { l.items[idx].checked = t.checked; l.updatedAt = nowISO(); }
    }, { render: false });
    t.closest('.check-row').classList.toggle('done', t.checked);
    refreshListProgressDOM(getList(r.id));
  } else if (t.matches('[data-check="pick"]')) {
    const p = state.ui.pick;
    if (!p) return;
    const k = t.dataset.key;
    if (t.checked) p.selected.add(k); else p.selected.delete(k);
    const c = document.getElementById('pick-count');
    if (c) c.textContent = p.selected.size;
  } else if (t.matches('[data-check="autosync"]')) {
    if (state.config) { state.config.autoSync = t.checked; persistConfig(); }
  } else if (t.id === 'import-file') {
    handleImportFile(t);
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'pool-search') {
    state.ui.poolSearch = t.value;
    const el = document.getElementById('pool-results');
    if (el) el.innerHTML = poolResultsHTML();
  } else if (t.id === 'pick-search') {
    state.ui.pick.search = t.value;
    const el = document.getElementById('pick-results');
    if (el) el.innerHTML = pickResultsHTML();
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'quick-add') { e.preventDefault(); doQuickAdd(); }
  else if (e.target.matches('[data-add-pool]')) { e.preventDefault(); doPoolAdd(e.target.dataset.addPool); }
  else if (e.target.id === 'nl-name') { e.preventDefault(); doNewListCreate(); }
});

window.addEventListener('hashchange', () => { renderRoute(); });

window.addEventListener('pageshow', e => { if (e.persisted) renderRoute(); });

/* ==================================================================
 * 8. PWA 与初始化
 * ================================================================== */
if ('serviceWorker' in navigator) {
  try { navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch (e) { /* ignore */ }
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'updated') toast('应用已更新');
  });
}

loadState();
renderRoute();
if (Sync.configured()) {
  syncNow(state.dirty ? { successToast: false, errorToast: true } : { successToast: false, errorToast: false });
}
