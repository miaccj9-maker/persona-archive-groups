import {
    eventSource,
    event_types,
    getThumbnailUrl,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../../scripts/extensions.js';
// 直接用核心对象，不依赖 getContext 的属性名，更稳
import { power_user } from '../../../../scripts/power-user.js';
import { characters } from '../../../../script.js';
import { user_avatar, getUserAvatars } from '../../../../scripts/personas.js';
import { Popup, POPUP_TYPE } from '../../../../scripts/popup.js';

const MODULE_NAME = 'persona-archive-groups';
const MODULE_VERSION = '1.6.1';

// ========== 设置 ==========
if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {
        enabled: true,
        autoExpandCurrent: true,
        personaNotes: {}, // { [面具头像文件名]: 备注名 }
        customFolders: [], // [{ id, name, items:[personaId] }]
    };
}
const settings = extension_settings[MODULE_NAME];
if (!settings.personaNotes) settings.personaNotes = {};
if (!Array.isArray(settings.customFolders)) settings.customFolders = [];

const expandedSet = new Set();
let debounceTimer = null;
let rendering = false;

function saveSettings() {
    try { getContext().saveSettingsDebounced(); } catch (e) { console.warn(e); }
}

function debounceRegroup(wait = 160) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        try { regroup(); } catch (e) { console.warn(`[${MODULE_NAME}] regroup 失败:`, e); }
    }, wait);
}

// ========== 分组数据 ==========

function getFilteredPersonas() {
    const all = Object.keys(power_user.personas || {});
    const q = (document.getElementById('persona_search_bar')?.value || '').trim().toLowerCase();
    if (!q) return all;
    return all.filter(id => {
        const name = String(power_user.personas?.[id] || '').toLowerCase();
        const desc = String(power_user.persona_descriptions?.[id]?.description || '').toLowerCase();
        const title = String(power_user.persona_descriptions?.[id]?.title || '').toLowerCase();
        return name.includes(q) || desc.includes(q) || title.includes(q);
    });
}

function sortPersonaIds(ids) {
    const dir = power_user.persona_sort_order === 'desc' ? -1 : 1;
    return ids.slice().sort((a, b) => {
        const an = String(power_user.personas?.[a] || a);
        const bn = String(power_user.personas?.[b] || b);
        return an.localeCompare(bn) * dir;
    });
}

// 遍历角色库全部角色，每个角色一个存档夹：
// 连接到该角色的面具列入 items；没连接的显示 0 个。
// 面具本身连接了哪些角色，就会出现在哪些角色的组里。
function buildGroups(personaIds) {
    // charAvatar -> Set<personaId>
    const charMap = new Map();
    for (const id of personaIds) {
        const conns = power_user.persona_descriptions?.[id]?.connections ?? [];
        const charIds = [...new Set(
            conns.filter(c => c && c.type === 'character' && c.id).map(c => c.id)
        )];
        for (const cid of charIds) {
            if (!charMap.has(cid)) charMap.set(cid, new Set());
            charMap.get(cid).add(id);
        }
    }

    const groups = [];
    const usedAvatars = new Set();
    for (const ch of (characters || [])) {
        if (!ch || !ch.avatar) continue;
        usedAvatars.add(ch.avatar);
        const set = charMap.get(ch.avatar);
        groups.push({
            key: 'char:' + ch.avatar,
            kind: 'char',
            charAvatar: ch.avatar,
            charName: ch.name || ch.avatar,
            items: set ? sortPersonaIds([...set]) : [],
        });
    }
    // 只保留库里真实存在的角色；已删除角色卡不再生成幽灵分组（其面具归入"未绑定角色"）

    // 排序：有面具的在前、空的在后；组内按显示名排序
    groups.sort((a, b) => {
        const ae = a.items.length > 0 ? 0 : 1;
        const be = b.items.length > 0 ? 0 : 1;
        if (ae !== be) return ae - be;
        return a.charName.localeCompare(b.charName);
    });

    // 自定义存档夹（手动）
    for (const cf of settings.customFolders) {
        const items = (cf.items || []).filter(id => power_user.personas?.[id]);
        groups.push({
            key: 'custom:' + cf.id,
            kind: 'custom',
            customId: cf.id,
            charAvatar: null,
            charName: cf.name || '未命名存档',
            items: sortPersonaIds(items),
        });
    }

    // 完全没有角色连接的面具，统一放最后
    const unbound = personaIds.filter(id =>
        !(power_user.persona_descriptions?.[id]?.connections ?? []).some(c => c && c.type === 'character')
    );
    if (unbound.length) {
        groups.push({ key: '__none__', kind: 'none', charAvatar: null, charName: '未绑定角色', items: sortPersonaIds(unbound) });
    }
    return groups;
}

// ========== 构建元素 ==========

function buildPersonaContainer(id) {
    const tpl = document.querySelector('#user_avatar_template .avatar-container');
    const el = tpl.cloneNode(true);

    const name = power_user.personas?.[id] || '[Unnamed Persona]';
    const desc = power_user.persona_descriptions?.[id]?.description || '';
    const title = power_user.persona_descriptions?.[id]?.title || '';
    const noDesc = document.getElementById('user_avatar_block')?.getAttribute('no_desc_text') || '';

    el.setAttribute('data-avatar-id', id);
    el.querySelector('.ch_name').textContent = name;
    el.querySelector('.ch_additional_info').textContent = title;
    const descEl = el.querySelector('.ch_description');
    const finalDesc = desc || noDesc;
    descEl.textContent = finalDesc;
    descEl.classList.toggle('text_muted', !desc);
    if (finalDesc.split('\n').length < 3) descEl.textContent = finalDesc + '\n \n ';

    const avatarEl = el.querySelector('.avatar');
    avatarEl.setAttribute('data-avatar-id', id);
    avatarEl.setAttribute('title', id);
    const img = el.querySelector('img');
    if (img) img.src = getThumbnailUrl('persona', id);

    el.classList.toggle('default_persona', id === power_user.default_persona);
    el.classList.toggle('selected', id === user_avatar);

    return el;
}

// 卡片外（兄弟节点）的极简备注行，避开固定高度卡片的裁剪
function buildNoteRow(id, folderId = null) {
    const note = settings.personaNotes?.[id] || '';
    const row = document.createElement('div');
    row.className = 'pag-note-row';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-pen pag-note-icon' + (note ? ' has-note' : '');
    icon.title = note ? `备注：${note}` : '给这个面具备注';
    icon.style.fontSize = '.75em';
    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const cur = settings.personaNotes?.[id] || '';
        const v = window.prompt('给这个面具备注名（留空清除）：', cur);
        if (v === null) return;
        const val = v.trim();
        if (!settings.personaNotes) settings.personaNotes = {};
        if (val) settings.personaNotes[id] = val;
        else delete settings.personaNotes[id];
        saveSettings();
        regroup();
    });
    row.appendChild(icon);

    if (note) {
        const txt = document.createElement('span');
        txt.className = 'pag-pnote';
        txt.textContent = note;
        row.appendChild(txt);
    }

    // 归入自定义存档
    const addToFolder = document.createElement('i');
    addToFolder.className = 'fa-solid fa-folder-plus pag-note-icon';
    addToFolder.title = '把这个面具加入自定义存档';
    addToFolder.style.marginLeft = '8px';
    addToFolder.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        pickFolderToAdd(id);
    });
    row.appendChild(addToFolder);

    // 在某个自定义存档内：移出
    if (folderId) {
        const rm = document.createElement('i');
        rm.className = 'fa-solid fa-x pag-note-icon';
        rm.title = '从此存档移出（不删面具）';
        rm.style.marginLeft = '4px';
        rm.style.opacity = '.6';
        rm.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const cf = settings.customFolders.find(x => x.id === folderId);
            if (!cf) return;
            cf.items = (cf.items || []).filter(x => x !== id);
            saveSettings();
            regroup();
        });
        row.appendChild(rm);
    }

    return row;
}

function displayGroupName(g) {
    return g.charName;
}

// 把面具连接到指定角色（幂等）
function bindPersonaToCharacter(personaId, charAvatar) {
    if (!personaId || !charAvatar) return false;
    if (!power_user.persona_descriptions[personaId]) return false;
    if (!Array.isArray(power_user.persona_descriptions[personaId].connections)) {
        power_user.persona_descriptions[personaId].connections = [];
    }
    const conns = power_user.persona_descriptions[personaId].connections;
    const exists = conns.some(c => c && c.type === 'character' && c.id === charAvatar);
    if (exists) return false;
    conns.push({ type: 'character', id: charAvatar });
    saveSettings();
    return true;
}

// 自定义面具选择器：头像 + 名字 + 描述首行 + 已绑定角色，同头像也能分清
async function showPersonaPicker(charName, alreadyBound) {
    const allPersonas = Object.keys(power_user.personas || {});
    if (allPersonas.length === 0) return null;

    const content = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = `绑定面具到「${charName}」`;
    const hint = document.createElement('div');
    hint.className = 'pag-pick-hint';
    hint.textContent = '点选一个面具进行绑定（带“已连接”的表示已连到本角色）：';
    const list = document.createElement('div');
    list.className = 'pag-pick-list';

    let popup;

    for (const id of sortPersonaIds(allPersonas)) {
        const row = document.createElement('div');
        row.className = 'pag-pick-row';
        if (alreadyBound.includes(id)) row.classList.add('is-bound');

        const av = document.createElement('img');
        av.className = 'pag-pick-avatar';
        av.src = getThumbnailUrl('persona', id);
        av.alt = '';
        av.loading = 'lazy';

        const mid = document.createElement('div');
        mid.className = 'pag-pick-mid';
        const nm = document.createElement('div');
        nm.className = 'pag-pick-name';
        nm.textContent = power_user.personas?.[id] || '[Unnamed]';
        if (alreadyBound.includes(id)) {
            const tag = document.createElement('span');
            tag.className = 'pag-pick-tag';
            tag.textContent = '已连接';
            nm.appendChild(tag);
        }

        // 备注：在绑定列表里也显示，可编辑
        const curNote = settings.personaNotes?.[id] || '';
        if (curNote) {
            const nt = document.createElement('span');
            nt.className = 'pag-pick-note';
            nt.textContent = '📝 ' + curNote;
            nm.appendChild(nt);
        }
        const editNt = document.createElement('i');
        editNt.className = 'fa-solid fa-pen pag-pick-editnote';
        editNt.title = '给这个面具备注';
        editNt.addEventListener('click', (e) => {
            e.stopPropagation();
            const v = window.prompt('给这个面具备注名（留空清除）：', curNote);
            if (v === null) return;
            const val = v.trim();
            if (!settings.personaNotes) settings.personaNotes = {};
            if (val) settings.personaNotes[id] = val;
            else delete settings.personaNotes[id];
            saveSettings();
            debounceRegroup(150);
            // 刷新弹窗内显示
            if (val) {
                if (!nt.isConnected) nm.appendChild(nt);
                nt.textContent = '📝 ' + val;
            } else if (nt.isConnected) {
                nt.remove();
            }
        });
        nm.appendChild(editNt);

        const ds = document.createElement('div');
        ds.className = 'pag-pick-desc';
        const rawDesc = String(power_user.persona_descriptions?.[id]?.description || '').replace(/\s+/g, ' ').trim();
        ds.textContent = rawDesc ? rawDesc.slice(0, 70) : '（无描述）';
        mid.append(nm, ds);

        row.append(av, mid);
        row.addEventListener('click', () => { popup.complete(id); });
        list.appendChild(row);
    }

    content.append(h3, hint, list);

    popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: '取消', allowEscapeClose: true });
    const result = await popup.show();
    return typeof result === 'string' ? result : null;
}

// 向某个自定义存档添加面具（循环选，直到取消）
async function addPersonasToFolder(folderId) {
    const cf = settings.customFolders.find(x => x.id === folderId);
    if (!cf) return;
    if (!Array.isArray(cf.items)) cf.items = [];
    while (true) {
        const picked = await showPersonaPicker(`存档「${cf.name}」`, cf.items);
        if (!picked) break;
        if (!cf.items.includes(picked)) cf.items.push(picked);
        saveSettings();
        regroup();
    }
}

// 新建自定义存档
function createCustomFolder() {
    const v = window.prompt('新存档名字：', '我的存档');
    if (v === null) return;
    const name = v.trim() || '未命名存档';
    settings.customFolders.push({ id: 'cf' + Date.now() + Math.random().toString(36).slice(2, 6), name, items: [] });
    saveSettings();
    regroup();
}

// 把面具加入某个自定义存档（选已有或新建）
async function pickFolderToAdd(personaId) {
    const content = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = '把面具加入存档';
    const list = document.createElement('div');
    list.className = 'pag-pick-list';

    let popup;
    const mkRow = (label, onclick) => {
        const row = document.createElement('div');
        row.className = 'pag-pick-row';
        row.innerHTML = `<span style="font-size:1.1em">${label}</span>`;
        row.addEventListener('click', () => { popup.complete(label); });
        list.appendChild(row);
        return row;
    };
    if (settings.customFolders.length === 0) {
        const empty = document.createElement('div');
        empty.style.opacity = '.7';
        empty.textContent = '还没有存档，点下方新建。';
        list.appendChild(empty);
    }
    for (const cf of settings.customFolders) {
        mkRow(`📁 ${cf.name}（${(cf.items || []).length}）`, () => cf.id);
    }
    const nf = mkRow('＋ 新建存档并加入', null);
    content.append(h3, list);

    popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: '取消', allowEscapeClose: true });
    const picked = await popup.show();
    if (typeof picked !== 'string') return;

    let target;
    if (picked.startsWith('＋ 新建存档')) {
        const v = window.prompt('新存档名字：', '我的存档');
        if (v === null) return;
        target = { id: 'cf' + Date.now() + Math.random().toString(36).slice(2, 6), name: v.trim() || '未命名存档', items: [] };
        settings.customFolders.push(target);
    } else {
        const id = picked.replace(/^📁\s/, '').replace(/（\d+）$/, '').trim();
        target = settings.customFolders.find(cf => cf.name === id);
    }
    if (!target) return;
    if (!Array.isArray(target.items)) target.items = [];
    if (!target.items.includes(personaId)) target.items.push(personaId);
    saveSettings();
    regroup();
}

// 弹出面具选择器，把选中的面具绑到该角色
async function openBinder(g) {
    try {
        const picked = await showPersonaPicker(g.charName, g.items);
        if (picked) {
            const ok = bindPersonaToCharacter(picked, g.charAvatar);
            if (ok) debounceRegroup(150);
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] 绑定失败:`, e);
    }
}


function buildGroupHeader(g) {
    const header = document.createElement('div');
    header.className = 'pag-group-header';

    const chev = document.createElement('i');
    chev.className = 'fa-solid fa-chevron-right pag-chevron';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'pag-group-avatar';
    if (g.kind === 'char' && g.charAvatar) {
        const img = document.createElement('img');
        img.src = getThumbnailUrl('avatar', g.charAvatar);
        img.alt = '';
        img.draggable = false;
        avatarWrap.appendChild(img);
    } else if (g.kind === 'custom') {
        const ic = document.createElement('i');
        ic.className = 'fa-solid fa-folder-open';
        avatarWrap.appendChild(ic);
    } else {
        const ic = document.createElement('i');
        ic.className = 'fa-solid fa-user-slash';
        avatarWrap.appendChild(ic);
    }

    const name = document.createElement('strong');
    name.className = 'pag-group-name';
    name.textContent = displayGroupName(g);

    const count = document.createElement('span');
    count.className = 'pag-group-count';
    count.textContent = `${g.items.length} 个面具`;

    header.append(chev, avatarWrap, name, count);

    // 自定义存档：重命名 + 删除
    if (g.kind === 'custom') {
        const rename = document.createElement('i');
        rename.className = 'fa-solid fa-pen pag-group-op';
        rename.title = '重命名存档';
        rename.addEventListener('click', (e) => {
            e.stopPropagation();
            const cf = settings.customFolders.find(x => x.id === g.customId);
            if (!cf) return;
            const v = window.prompt('存档名：', cf.name || '');
            if (v === null) return;
            cf.name = v.trim() || '未命名存档';
            saveSettings();
            regroup();
        });
        const del = document.createElement('i');
        del.className = 'fa-solid fa-trash pag-group-op';
        del.title = '删除此存档（不删面具）';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!window.confirm(`删除存档「${g.charName}」？（只删存档，不删面具）`)) return;
            settings.customFolders = settings.customFolders.filter(x => x.id !== g.customId);
            saveSettings();
            regroup();
        });
        header.append(rename, del);
    }

    return header;
}

// ========== 主渲染 ==========

function shouldOpen(g) {
    const q = (document.getElementById('persona_search_bar')?.value || '').trim();
    if (q) return true;
    if (expandedSet.has(g.key)) return true;
    if (settings.autoExpandCurrent && g.items.includes(user_avatar)) return true;
    return false;
}

function regroup() {
    if (!settings.enabled) return;
    const block = document.getElementById('user_avatar_block');
    if (!block) return;

    const personas = getFilteredPersonas();
    if (personas.length === 0) return;

    rendering = true;
    try {
        const groups = buildGroups(personas);
        block.innerHTML = '';
        const frag = document.createDocumentFragment();

        // 顶部：新建自定义存档
        const newBtn = document.createElement('div');
        newBtn.className = 'pag-add-btn pag-new-folder';
        newBtn.innerHTML = '<i class="fa-solid fa-folder-plus"></i><span>新建自定义存档</span>';
        newBtn.addEventListener('click', () => createCustomFolder());
        frag.appendChild(newBtn);

        for (const g of groups) {
            const header = buildGroupHeader(g);
            const body = document.createElement('div');
            body.className = 'pag-group-body';
            for (const id of g.items) {
                body.appendChild(buildPersonaContainer(id));
                body.appendChild(buildNoteRow(id, g.kind === 'custom' ? g.customId : null));
            }

            // 角色分组：底部加一个“绑定面具”按钮
            if (g.kind === 'char') {
                const addBtn = document.createElement('div');
                addBtn.className = 'pag-add-btn';
                addBtn.innerHTML = '<i class="fa-solid fa-plus"></i><span>从已有面具绑定到本角色</span>';
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openBinder(g);
                });
                body.appendChild(addBtn);
            }

            // 自定义存档：底部加“向此存档添加面具”
            if (g.kind === 'custom') {
                const addBtn = document.createElement('div');
                addBtn.className = 'pag-add-btn';
                addBtn.innerHTML = '<i class="fa-solid fa-plus"></i><span>向此存档添加面具</span>';
                addBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addPersonasToFolder(g.customId);
                });
                body.appendChild(addBtn);
            }

            const open = shouldOpen(g);
            header.classList.toggle('pag-open', open);
            body.classList.toggle('pag-open', open);

            header.addEventListener('click', () => {
                const isOpen = header.classList.toggle('pag-open');
                body.classList.toggle('pag-open', isOpen);
                if (isOpen) expandedSet.add(g.key); else expandedSet.delete(g.key);
            });

            frag.append(header, body);
        }

        block.appendChild(frag);
        block.scrollTop = 0;
    } finally {
        setTimeout(() => { rendering = false; }, 0);
    }
}

async function restoreNative() {
    const block = document.getElementById('user_avatar_block');
    if (block) block.classList.remove('pag-active');
    setPaginationHidden(false);
    try { await getUserAvatars(true, user_avatar); } catch (e) { console.warn(e); }
}

// ========== 监听 ==========

function setPaginationHidden(hidden) {
    const pag = document.getElementById('persona_pagination_container');
    if (pag) pag.classList.toggle('pag-hidden', hidden);
}

function initObserver() {
    const block = document.getElementById('user_avatar_block');
    if (!block) return;
    block.classList.add('pag-active');
    setPaginationHidden(true);

    const mo = new MutationObserver(() => {
        if (rendering) return;
        debounceRegroup();
    });
    mo.observe(block, { childList: true, subtree: true });

    const search = document.getElementById('persona_search_bar');
    if (search) search.addEventListener('input', () => debounceRegroup(150));
}

// ========== 设置面板 ==========

function createSettingsPanel() {
    const container = document.createElement('div');
    container.id = 'pag-extension-panel';
    container.className = 'inline-drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    header.innerHTML = `
        <span>🎭 面具合并存档（按角色分组）</span>
        <span class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></span>`;

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'checkbox_label';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !!settings.enabled;
    toggle.addEventListener('change', async (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        if (settings.enabled) {
            document.getElementById('user_avatar_block')?.classList.add('pag-active');
            setPaginationHidden(true);
            debounceRegroup(100);
        } else {
            await restoreNative();
        }
    });
    toggleLabel.append(toggle, document.createTextNode(' 启用按角色合并面具存档'));

    const autoLabel = document.createElement('label');
    autoLabel.className = 'checkbox_label';
    const autoToggle = document.createElement('input');
    autoToggle.type = 'checkbox';
    autoToggle.checked = settings.autoExpandCurrent !== false;
    autoToggle.addEventListener('change', (e) => {
        settings.autoExpandCurrent = e.target.checked;
        saveSettings();
        debounceRegroup(100);
    });
    autoLabel.append(autoToggle, document.createTextNode(' 默认展开当前面具所在分组'));

    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:.7;font-size:.9em;line-height:1.5;margin-top:6px;';
    hint.textContent = '说明：面具连接到哪个角色就收进哪个角色的存档夹（夹名=角色名）；鼠标悬停面具卡片，点右上角铅笔可给该面具备注。仅改展示，不改面具数据。';

    content.append(toggleLabel, autoLabel, hint);
    container.append(header, content);

    const host = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2');
    if (host) host.appendChild(container);
}

// ========== 入口 ==========

export async function init() {
    console.log(`[${MODULE_NAME}] v${MODULE_VERSION} 初始化, 面具总数=${Object.keys(power_user.personas || {}).length}`);

    createSettingsPanel();

    const start = () => {
        initObserver();
        debounceRegroup(120);

        // 手机端：点选面具后，把编辑面板滚到面具下方可见处
        const block = document.getElementById('user_avatar_block');
        if (block && !block.dataset.pagMobileBound) {
            block.dataset.pagMobileBound = '1';
            block.addEventListener('click', (e) => {
                if (window.innerWidth > 1000) return;
                const card = e.target.closest('.avatar-container');
                if (!card) return;
                setTimeout(() => {
                    const rightCol = document.querySelector('#persona-management-block .persona_management_right_column');
                    if (rightCol) rightCol.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 120);
            });
        }
    };

    if (document.getElementById('user_avatar_block')) {
        start();
    } else {
        const t = setInterval(() => {
            if (document.getElementById('user_avatar_block')) {
                clearInterval(t);
                start();
            }
        }, 1000);
    }

    eventSource.on(event_types.PERSONA_CHANGED, () => debounceRegroup(150));

    setTimeout(() => debounceRegroup(500), 800);
    setTimeout(() => debounceRegroup(500), 2000);

    console.log(`[${MODULE_NAME}] 初始化完成`);
}

export async function loop() { /* 无需循环 */ }
