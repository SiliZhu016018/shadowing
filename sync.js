/* ============================================================
 * Shadowing English · 云同步模块（Supabase）
 * 接入步骤：注册 Supabase → 跑 supabase-schema.sql → 把下面两个常量填进来
 * 三个 HTML 都 <script src="sync.js"></script> 引入，调用 window.Sync.* 即可
 * ============================================================ */

// 👇 注册 Supabase 后，把这俩换成你项目的值（Dashboard → Settings → API）
const SUPABASE_URL = "https://xnydehbezqzqphdlnbcs.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhueWRlaGJlenF6cXBoZGxuYmNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMjIzNDAsImV4cCI6MjEwMjY5ODM0MH0.XUR1LSa9sKw2QzPNBlw9MgYgeSHPKdlyFFhpD9I6bmg";

let _sb = null;        // supabase 客户端实例
let _user = null;      // 当前登录用户 {id, email}
let _authCbs = [];     // 登录状态变化回调

// 动态加载 supabase-js（ESM）
async function _loadClient() {
  if (_sb) return _sb;
  if (!SUPABASE_URL || SUPABASE_URL.indexOf("YOUR-") === 0) return null;
  const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  _sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // 恢复已有会话
  const { data: { session } } = await _sb.auth.getSession();
  if (session) _user = { id: session.user.id, email: session.user.email || "" };
  _sb.auth.onAuthStateChange(function (_evt, session) {
    _user = session && session.user ? { id: session.user.id, email: session.user.email || "" } : null;
    _authCbs.forEach(function (cb) { try { cb(_user); } catch (e) {} });
  });
  return _sb;
}

function _uid() { return _user ? _user.id : null; }

const Sync = {
  // 启动时调用：加载客户端 + 恢复会话
  async init() {
    const c = await _loadClient();
    return !!c && !!_user;
  },

  // 是否已配置 Supabase（没填 key 返回 false）
  isConfigured() { return SUPABASE_URL && SUPABASE_URL.indexOf("YOUR-") !== 0; },
  // 是否已登录
  isAuthed() { return !!_user; },
  // 当前用户 {id, email} 或 null
  getUser() { return _user; },
  // 注册登录状态变化回调
  onAuthChange(cb) { _authCbs.push(cb); if (_user) cb(_user); },

  // 邮箱密码注册
  async signUp(email, password) {
    const c = await _loadClient(); if (!c) throw new Error("Supabase 未配置");
    const { data, error } = await c.auth.signUp({ email: email, password: password });
    if (error) throw error;
    return data.user;
  },
  // 邮箱密码登录
  async signIn(email, password) {
    const c = await _loadClient(); if (!c) throw new Error("Supabase 未配置");
    const { data, error } = await c.auth.signInWithPassword({ email: email, password: password });
    if (error) throw error;
    _user = { id: data.user.id, email: data.user.email || "" };
    _authCbs.forEach(function (cb) { try { cb(_user); } catch (e) {} });
    return _user;
  },
  // 退出
  async signOut() {
    const c = await _loadClient(); if (!c) return;
    await c.auth.signOut();
    _user = null;
    _authCbs.forEach(function (cb) { try { cb(null); } catch (e) {} });
  },

  // 拉取云端全部数据（启动时同步用）
  // 返回 { materials: [...], vocab: {materialId: [...]}, progress: {materialId: {...}}, lastMaterialId }
  async fetchAll() {
    const c = await _loadClient(); if (!c || !_user) return null;
    const uid = _uid();
    const [m, v, p, s] = await Promise.all([
      c.from("materials").select("*").eq("user_id", uid),
      c.from("vocab").select("*").eq("user_id", uid),
      c.from("progress").select("*").eq("user_id", uid),
      c.from("user_settings").select("*").eq("user_id", uid).maybeSingle(),
    ]);

    const materials = (m.data || []).map(function (row) {
      return {
        id: row.id, userId: row.user_id, title: row.title, audioName: row.audio_name,
        audioPath: row.audio_path, sentences: row.sentences || [], meta: row.meta || {},
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    });
    console.log("[Sync] fetchAll → 云端材料数:", materials.length, materials.map(function (x) { return x.id + (x.audioPath ? "(有音频)" : "(无音频)"); }));
    const vocab = {};
    (v.data || []).forEach(function (r) {
      if (!vocab[r.material_id]) vocab[r.material_id] = [];
      vocab[r.material_id].push({
        word: r.word, note: r.note, example: r.example,
        srcSentenceIdx: r.src_sentence_idx, srcText: r.src_text,
        level: r.level, reps: r.reps, due: r.due,
        lastReview: r.last_review, lastGrade: r.last_grade,
        createdAt: r.created_at, updatedAt: r.updated_at,
      });
    });
    const progress = {};
    (p.data || []).forEach(function (r) {
      progress[r.material_id] = {
        played: r.played || [], hard: r.hard || [], lastIndex: r.last_index || 0,
        updatedAt: r.updated_at,
      };
    });
    return {
      materials: materials,
      vocab: vocab,
      progress: progress,
      lastMaterialId: s.data ? s.data.last_material_id : null,
    };
  },

  // 下载某材料的音频 blob（按 audioPath）
  async downloadAudio(audioPath) {
    const c = await _loadClient(); if (!c || !_user) return null;
    const { data, error } = await c.storage.from("audio").download(audioPath);
    if (error) throw error;
    return data; // data 已是 Blob
  },

  // 生成音频 URL（带签名，1 小时有效）
  async audioUrl(audioPath) {
    const c = await _loadClient(); if (!c || !_user) return null;
    const { data, error } = await c.storage.from("audio").createSignedUrl(audioPath, 3600);
    if (error) throw error;
    return data ? data.signedUrl : null;
  },

  // 上传/更新一个材料（含音频 blob）
  // material = { id, title, audioName, sentences, meta, audioBlob? }
  async upsertMaterial(material) {
    const c = await _loadClient(); if (!c || !_user) throw new Error("未登录");
    const uid = _uid();
    let audioPath = material.audioPath || null;

    // 有音频就上传到 Storage
    if (material.audioBlob) {
      audioPath = uid + "/" + material.id + ".mp3";
      const { error: upErr } = await c.storage.from("audio")
        .upload(audioPath, material.audioBlob, { upsert: true, contentType: "audio/mpeg" });
      if (upErr) throw upErr;
    } else if (!audioPath) {
      // 本地没有音频 blob，也没记录云端路径：先查云端是否已有该材料的音频，避免把已有音频覆盖成 null
      try {
        const { data: ex } = await c.from("materials").select("audio_path").eq("id", material.id).eq("user_id", uid).maybeSingle();
        if (ex && ex.audio_path) audioPath = ex.audio_path;
      } catch (e) { console.warn("[Sync] 读取已有 audio_path 失败", e); }
    }

    const row = {
      id: material.id, user_id: uid, title: material.title,
      audio_name: material.audioName, audio_path: audioPath,
      sentences: material.sentences, meta: material.meta || {},
    };
    const { error } = await c.from("materials").upsert(row);
    if (error) throw error;
    console.log("[Sync] upsertMaterial", material.id, "audio_path:", audioPath ? "已设置" : "null");
    return row;
  },

  // 删除云端材料（数据 + Storage 音频）
  async deleteMaterial(materialId, audioPath) {
    const c = await _loadClient(); if (!c || !_user) return;
    await c.from("materials").delete().eq("id", materialId).eq("user_id", _uid());
    await c.from("vocab").delete().eq("material_id", materialId).eq("user_id", _uid());
    await c.from("progress").delete().eq("material_id", materialId).eq("user_id", _uid());
    if (audioPath) {
      try { await c.storage.from("audio").remove([audioPath]); } catch (e) {}
    }
  },

  // 覆盖式上传某材料的生词（先删旧的再插新的，简单可靠）
  async upsertVocab(materialId, vocabArray) {
    const c = await _loadClient(); if (!c || !_user) throw new Error("未登录");
    const uid = _uid();
    await c.from("vocab").delete().eq("material_id", materialId).eq("user_id", uid);
    if (!vocabArray || !vocabArray.length) return;
    const rows = vocabArray.map(function (v) {
      return {
        user_id: uid, material_id: materialId,
        word: v.word || "", note: v.note || "", example: v.example || "",
        src_sentence_idx: v.srcSentenceIdx ?? null, src_text: v.srcText || "",
        level: v.level || 0, reps: v.reps || 0, due: v.due || null,
        last_review: v.lastReview || null, last_grade: v.lastGrade || null,
      };
    });
    const { error } = await c.from("vocab").insert(rows);
    if (error) throw error;
  },

  // 上传某材料的学习进度
  async upsertProgress(materialId, progressObj) {
    const c = await _loadClient(); if (!c || !_user) throw new Error("未登录");
    const uid = _uid();
    const row = {
      user_id: uid, material_id: materialId,
      played: progressObj.played || [], hard: progressObj.hard || [],
      last_index: progressObj.lastIndex || 0,
    };
    const { error } = await c.from("progress").upsert(row);
    if (error) throw error;
  },

  // 记住上次用的材料
  async setLastMaterial(materialId) {
    const c = await _loadClient(); if (!c || !_user) return;
    const uid = _uid();
    const { error } = await c.from("user_settings").upsert({
      user_id: uid, last_material_id: materialId,
    });
    if (error) console.warn("[Sync] setLastMaterial failed", error.message);
  },

  // === 便捷方法：让三个页面不写重复逻辑 ===

  // 拉云端全量并写入本地 IndexedDB + localStorage（覆盖式）
  async pullFromCloud() {
    if (!Sync.isAuthed()) return null;
    // 双向合并：先拉云端 → 合并进本地（不清本地）→ 再把云端没有的本地材料推上去
    // 这样本地独有数据不会丢、云端独有数据也能下到本地，且不会用旧版本覆盖新版本
    const data = await Sync.fetchAll();
    if (!data) return null;
    await Sync.applyCloudDataToLocal(data);
    const cloudIds = new Set((data.materials || []).map(function (m) { return m.id; }));
    console.log("[Sync] pullFromCloud cloudIds:", Array.from(cloudIds));
    await Sync.pushLocalAll(cloudIds);
    return data;
  },

  // 上传一个材料（含音频 blob）到云端
  async uploadMaterial(materialId, audioBlob, sentences, meta, title, audioName) {
    if (!Sync.isAuthed()) return;
    await Sync.upsertMaterial({
      id: materialId, title: title || materialId,
      audioName: audioName, sentences: sentences,
      meta: meta || {}, audioBlob: audioBlob || null,
    });
  },

  // 上传某材料的生词（覆盖式）
  async uploadVocab(materialId, vocabArr) {
    if (!Sync.isAuthed()) return;
    await Sync.upsertVocab(materialId, vocabArr);
  },

  // 上传某材料的学习进度
  async uploadProgress(materialId, playedArr, hardArr, lastIndex) {
    if (!Sync.isAuthed()) return;
    await Sync.upsertProgress(materialId, {
      played: playedArr || [], hard: hardArr || [], lastIndex: lastIndex || 0,
    });
  },
};

// 把云端 fetchAll 返回的数据写入本地
Sync.applyCloudDataToLocal = async function (data) {
  if (!data) return;
  // 合并模式：只把云端有的材料写回本地（按 id 覆盖），绝不删除本地独有材料 —— 防止「云端空 → 清空本地」的数据丢失
  // 云端音频路径带进 meta，播放时直接用签名 URL（无需下载 blob，跨设备更稳）；同时把 blob 也存一份作为离线兜底
  for (const m of (data.materials || [])) {
    const mat = {
      sentences: m.sentences || [],
      meta: Object.assign({}, m.meta || {}, { audioPath: m.audioPath || null }),
      title: m.title,
      audio: m.audioName,
    };
    let blob = null;
    if (m.audioPath) {
      try { const buf = await Sync.downloadAudio(m.audioPath); blob = new Blob([buf], { type: "audio/mpeg" }); }
      catch (e) { console.warn("[Sync] downloadAudio failed", m.id, e); }
    }
    if (!blob) { try { const ex = await window._idbGet(m.id); if (ex) blob = ex.audioBlob || null; } catch (e) {} }
    try { await window._idbPut(m.id, mat, blob); }
    catch (e) { console.warn("[Sync] put material failed", m.id, e); }
  }
  // 写入 vocab
  for (const [mid, arr] of Object.entries(data.vocab || {})) {
    try { localStorage.setItem("shadowing:vocab:" + mid, JSON.stringify(arr)); } catch (e) {}
  }
  // 写入 progress
  for (const [mid, p] of Object.entries(data.progress || {})) {
    try {
      localStorage.setItem("shadowing:progress:" + mid, JSON.stringify({ played: p.played || [], lastIndex: p.lastIndex || 0 }));
      localStorage.setItem("shadowing:hard:" + mid, JSON.stringify(p.hard || []));
    } catch (e) {}
  }
  if (data.lastMaterialId) {
    try { localStorage.setItem("shadowing:lastMaterialId", data.lastMaterialId); } catch (e) {}
  }
};

// 把本地 IndexedDB 中所有材料推到云端（登录/同步时调用，防止本地独有数据永久留在一台设备）
Sync.pushLocalAll = async function (existingIds) {
  if (!Sync.isAuthed()) return;
  let rows = [];
  try { rows = (await window._idbGetAll()) || []; } catch (e) { return; }
  const skip = existingIds instanceof Set ? existingIds : null;
  for (const r of rows) {
    try {
      const id = r.id;
      if (!id) continue;
      if (skip && skip.has(id)) continue;   // 云端已有：不回写，避免用本地旧版本覆盖云端新版本
      const material = r.material || {};
      const blob = r.audioBlob || null;
      await Sync.upsertMaterial({
        id: id,
        title: (material.meta && material.meta.title) || id,
        audioName: (material.meta && material.meta.audio) || "audio.mp3",
        sentences: material.sentences || [],
        meta: material.meta || {},
        audioBlob: blob,
      });
      try {
        const vb = JSON.parse(localStorage.getItem("shadowing:vocab:" + id) || "[]");
        if (vb && vb.length) await Sync.upsertVocab(id, vb);
      } catch (e) {}
      try {
        const pr = JSON.parse(localStorage.getItem("shadowing:progress:" + id) || "{}");
        const hd = JSON.parse(localStorage.getItem("shadowing:hard:" + id) || "[]");
        if (pr && (pr.played || pr.lastIndex)) await Sync.upsertProgress(id, pr.played || [], hd || [], pr.lastIndex || 0);
      } catch (e) {}
    } catch (e) { console.warn("[Sync] pushLocalOne failed", r && r.id, e); }
  }
};

// ============================================================
// 登录模态 + 账号按钮（自动注入页面，无需三个页面各自写 UI）
// ============================================================

function _ensureAuthOverlay() {
  let ov = document.getElementById("sync-auth-overlay");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.id = "sync-auth-overlay";
  ov.className = "sync-hidden";
  ov.innerHTML =
    '<div class="sync-auth-box">' +
      '<h3>☁️ 云同步 · 登录</h3>' +
      '<p class="sync-auth-hint">电脑手机登录同一账号，学习数据自动同步</p>' +
      '<input id="sync-auth-email" type="email" placeholder="邮箱" autocomplete="email" />' +
      '<input id="sync-auth-password" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password" />' +
      '<div id="sync-auth-err" class="sync-auth-err"></div>' +
      '<div class="sync-auth-actions">' +
          '<button id="sync-auth-signin" class="sync-btn-primary">登录</button>' +
          '<button id="sync-auth-signup">注册新账号</button>' +
        '</div>' +
      '<button id="sync-auth-close">稍后再说</button>' +
    "</div>";
  document.body.appendChild(ov);

  // 注入样式
  let css = document.getElementById("sync-auth-css");
  if (!css) {
    css = document.createElement("style");
    css.id = "sync-auth-css";
    css.textContent =
      "#sync-auth-overlay.sync-hidden { display: none; }" +
      "#sync-auth-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.45); backdrop-filter: blur(6px); z-index: 300; display: flex; align-items: center; justify-content: center; padding: 16px; }" +
      ".sync-auth-box { background: #fff; border-radius: 18px; padding: 22px; max-width: 360px; width: 100%; box-shadow: 0 20px 60px rgba(15,23,42,.25); }" +
      ".sync-auth-box h3 { margin: 0 0 6px; font-size: 18px; }" +
      ".sync-auth-hint { color: #64748b; font-size: 13px; margin: 0 0 14px; }" +
      ".sync-auth-box input { width: 100%; font: inherit; padding: 9px 12px; border: 1px solid rgba(15,23,42,.15); border-radius: 10px; margin-bottom: 8px; box-sizing: border-box; }" +
      ".sync-auth-box input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }" +
      ".sync-auth-err { color: #ef4444; font-size: 13px; min-height: 18px; margin-bottom: 4px; }" +
      ".sync-auth-actions { display: flex; gap: 8px; margin-bottom: 8px; }" +
      ".sync-auth-actions button { flex: 1; padding: 10px; font: inherit; border-radius: 10px; border: 1px solid rgba(15,23,42,.15); background: #fff; cursor: pointer; }" +
      ".sync-btn-primary { background: linear-gradient(135deg,#3b82f6,#6366f1)!important; color: #fff!important; border-color: transparent!important; font-weight: 600; }" +
      "#sync-auth-close { width: 100%; padding: 8px; font: inherit; background: none; border: none; color: #64748b; cursor: pointer; font-size: 13px; }" +
      ".nav-sync-acct { font-size: 12.5px; padding: 5px 10px; border-radius: 999px; border: 1px solid rgba(15,23,42,.15); background: rgba(255,255,255,.5); color: #1e293b; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }" +
      ".nav-sync-acct:hover { background: #f1f5f9; }" +
      ".nav-sync-acct .sync-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; display: inline-block; }" +
      ".nav-sync-acct.on .sync-dot { background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.18); }" +
      ".nav-sync-btn { font-size: 16px; padding: 5px 8px; border-radius: 999px; border: 1px solid rgba(15,23,42,.15); background: rgba(255,255,255,.5); color: #1e293b; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 28px; transition: opacity .2s; }" +
      ".nav-sync-btn:hover:not(:disabled) { background: #f1f5f9; }" +
      ".nav-sync-btn:disabled { cursor: wait; }";
    document.head.appendChild(css);
  }

  // 事件绑定
  document.getElementById("sync-auth-signin").addEventListener("click", async function () {
    var e = document.getElementById("sync-auth-email").value.trim();
    var p = document.getElementById("sync-auth-password").value;
    _setErr(""); await Sync.signIn(e, p).then(_onAuthSuccess).catch(function (err) { _setErr(err.message || String(err)); });
  });
  document.getElementById("sync-auth-signup").addEventListener("click", async function () {
    var e = document.getElementById("sync-auth-email").value.trim();
    var p = document.getElementById("sync-auth-password").value;
    _setErr(""); await Sync.signUp(e, p).then(function () { return Sync.signIn(e, p); }).then(_onAuthSuccess).catch(function (err) { _setErr(err.message || String(err)); });
  });
  document.getElementById("sync-auth-close").addEventListener("click", function () { _ensureAuthOverlay().classList.add("sync-hidden"); });
  ov.addEventListener("click", function (e) { if (e.target === ov) ov.classList.add("sync-hidden"); });
  return ov;
}
function _setErr(msg) { var el = document.getElementById("sync-auth-err"); if (el) el.textContent = msg || ""; }
function _onAuthSuccess() {
  _setErr("");
  _ensureAuthOverlay().classList.add("sync-hidden");
  // 通知页面做同步拉取
  if (typeof window.onSyncSignedIn === "function") {
    try { window.onSyncSignedIn(); } catch (e) { console.warn("[Sync] onSyncSignedIn error", e); }
  }
}

Sync.openAuth = function () {
  if (!Sync.isConfigured()) {
    alert("云同步未配置。请在 sync.js 顶部填入 SUPABASE_URL 和 SUPABASE_ANON_KEY。");
    return;
  }
  var ov = _ensureAuthOverlay();
  ov.classList.remove("sync-hidden");
  document.getElementById("sync-auth-email").focus();
};

// 把账号状态 + 手动同步按钮显示在指定 slot（每个页面的导航里加 <span class="nav-sync-slot"></span>）
Sync.mountAccountButton = function () {
  function render() {
    var slots = document.querySelectorAll(".nav-sync-slot");
    slots.forEach(function (slot) {
      var html = "";
      // 同步按钮（始终显示，未登录时灰色禁用态）
      html += '<button class="nav-sync-btn" id="nav-sync-refresh" title="从云端拉取最新数据">🔄</button>';
      if (_user) {
        html += '<button class="nav-sync-acct on" title="已登录 · 点击查看"><span class="sync-dot"></span>' +
          (_user.email || "已登录") + " · 退出</button>";
      } else {
        html += '<button class="nav-sync-acct">☁️ 登录同步</button>';
      }
      slot.innerHTML = html;

      // 同步按钮事件
      var btn = document.getElementById("nav-sync-refresh");
      if (btn) {
        if (!_user) { btn.style.opacity = "0.4"; btn.style.pointerEvents = "none"; }
        btn.addEventListener("click", function () {
          if (!_user) { Sync.openAuth(); return; }
          btn.disabled = true;
          btn.textContent = "⏳";
          // 优先用页面自定义的 syncPullAll（index.html 有完整刷新逻辑），否则走基础 pull
          var p = typeof window.syncPullAll === "function"
            ? window.syncPullAll()
            : Sync.pullFromCloud().then(function (d) {
                if (d && d.materials) {
                  if (typeof window.toast === "function") window.toast("已同步 " + d.materials.length + " 个材料");
                  else alert("已同步 " + d.materials.length + " 个材料");
                  if (typeof window.loadVocab === "function") window.loadVocab();
                  if (typeof window.renderList === "function") window.renderList();
                }
              });
          var done = false;
          function reset() { if (done) return; done = true; btn.disabled = false; btn.textContent = "🔄"; }
          p.finally(reset);
          // 30 秒超时兜底：无论如何恢复按钮，避免卡在 ⏳
          setTimeout(reset, 30000);
        });
      }

      // 账号按钮事件
      var acctBtn = slot.querySelector(".nav-sync-acct");
      if (acctBtn) {
        if (_user) {
          acctBtn.addEventListener("click", async function () {
            if (confirm("退出登录？退出后本地仍可使用，但不再同步到云端。")) {
              await Sync.signOut();
            }
          });
        } else {
          acctBtn.addEventListener("click", function () { Sync.openAuth(); });
        }
      }
    });
  }
  Sync.onAuthChange(render);
  render();
};

window.Sync = Sync;