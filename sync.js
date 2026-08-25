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

// === 性能优化：全局同步锁 + 结果缓存 ===
var _syncLock = false;           // 同步进行中标记（防止并发重复调用）
var _lastFetchResult = null;     // 上次 fetchAll 结果缓存
var _lastFetchTime = 0;          // 上次 fetchAll 时间戳
var FETCH_CACHE_TTL = 15000;     // 缓存有效期 15 秒（同一页面内不重复请求）

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
  // ⚡ 登录/会话就绪时广播事件，让页面侧（补传、补拉生词）能感知
  function _notifySignedIn() {
    if (_user) { try { window.dispatchEvent(new Event("sync-signed-in")); } catch (_) {} }
  }
  if (_user) _notifySignedIn(); // 初始恢复会话也可能早于页面渲染，需补广播一次
  _sb.auth.onAuthStateChange(function (_evt, session) {
    _user = session && session.user ? { id: session.user.id, email: session.user.email || "" } : null;
    _authCbs.forEach(function (cb) { try { cb(_user); } catch (e) {} });
    _notifySignedIn(); // 会话变化（登录/恢复/刷新 token）时广播
  });
  return _sb;
}

function _uid() { return _user ? _user.id : null; }

// vocab 表是否已迁移 SM-2 列（ef/interval）的探测结果缓存（会话内有效）
let _vocabSm2Column = null;
// 一次性探测 vocab 表是否含 ef/interval 列（SM-2 迁移前为 false，迁移后为 true；会话内缓存）。
// 迁移前若直接 insert ef/interval 会让 PostgREST 报「column does not exist」导致上传整体失败，
// 因此未迁移时按旧结构写入，保证稳定版不报错；迁移后自动带上 ef/interval。
async function _vocabSupportsSm2(c, uid) {
  if (_vocabSm2Column !== null) return _vocabSm2Column;
  try {
    await c.from("vocab").select("ef").eq("user_id", uid).limit(1);
    _vocabSm2Column = true;
  } catch (e) {
    console.warn("[Sync] vocab 表尚无 ef/interval 列（未迁移），按旧结构写入", e && e.message);
    _vocabSm2Column = false;
  }
  return _vocabSm2Column;
}

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
  // 清除 fetchAll 缓存（上传/删除/编辑后调用，确保下次拉取最新数据）
  clearFetchCache() { _lastFetchResult = null; _lastFetchTime = 0; },

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
  // 返回 { materials: [...], vocab: {materialId: [...]}, progress: {materialId: {...}}, lastMaterialId, deletedIds }
  // ⚡ 15 秒内重复调用直接返回缓存结果（避免页面加载时多触发点导致 2-3 轮全量请求）
  async fetchAll(force) {
    // 缓存命中：15 秒内不重复请求
    if (!force && _lastFetchResult && (Date.now() - _lastFetchTime) < FETCH_CACHE_TTL) {
      console.log("[Sync] fetchAll 命中缓存（", Math.round((Date.now() - _lastFetchTime) / 1000), "秒内）");
      return _lastFetchResult;
    }
    const c = await _loadClient(); if (!c || !_user) return null;
    const uid = _uid();
    const [m, v, p, s] = await Promise.all([
      c.from("materials").select("*").eq("user_id", uid),
      c.from("vocab").select("*").eq("user_id", uid),
      c.from("progress").select("*").eq("user_id", uid),
      c.from("user_settings").select("*").eq("user_id", uid).maybeSingle(),
    ]);

    // 诊断：打印 Supabase 返回的原始 materials 数据
    console.log("[Sync] fetchAll 原始数据:", JSON.stringify(m.data || []));

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
        ef: r.ef, interval: r.interval,
        ef_r: r.ef_r, interval_r: r.interval_r, reps_r: r.reps_r, due_r: r.due_r,
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
    var result = {
      materials: materials,
      vocab: vocab,
      progress: progress,
      lastMaterialId: s.data ? s.data.last_material_id : null,
      deletedIds: (s.data && Array.isArray(s.data.deleted_ids)) ? s.data.deleted_ids : [],
    };
    // 写入缓存
    _lastFetchResult = result;
    _lastFetchTime = Date.now();
    return result;
  },

  // 下载某材料的音频 blob（按 audioPath）
  async downloadAudio(audioPath) {
    const c = await _loadClient(); if (!c || !_user) return null;
    const { data, error } = await c.storage.from("audio").download(audioPath);
    if (error) throw error;
    return data; // data 已是 Blob
  },

  // 生成音频 URL（公开桶，不过期、CORS 稳定）
  async audioUrl(audioPath) {
    const c = await _loadClient(); if (!c || !_user) return null;
    const { data } = c.storage.from("audio").getPublicUrl(audioPath);
    return data ? data.publicUrl : null;
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
      console.log("[Sync] 音频已上传到 Storage:", audioPath);
    } else if (!audioPath) {
      // 本地没有音频 blob，也没记录云端路径：先查云端是否已有该材料的音频，避免把已有音频覆盖成 null
      try {
        const { data: ex } = await c.from("materials").select("audio_path").eq("id", material.id).eq("user_id", uid).maybeSingle();
        if (ex && ex.audio_path) {
          audioPath = ex.audio_path;
          console.log("[Sync] 保留云端已有 audio_path:", audioPath);
        }
      } catch (e) { console.warn("[Sync] 读取已有 audio_path 失败", e); }
    }

    // 构建写入行：audioPath 为 null 时绝不写入（防止 upsert 覆盖云端已有值为 null）
    var row = {
      id: material.id, user_id: uid, title: material.title,
      audio_name: material.audioName,
      sentences: material.sentences,
      // 同步更新 meta.audioPath，保持数据库顶层字段与 meta 嵌套字段一致
      meta: Object.assign({}, material.meta || {}, { audioPath: audioPath || (material.meta && material.meta.audioPath) || null }),
    };
    // 只有确认有有效音频路径时才写入 audio_path 字段
    if (audioPath) {
      row.audio_path = audioPath;
    }
    const { error } = await c.from("materials").upsert(row);
    if (error) throw error;
    console.log("[Sync] upsertMaterial", material.id, "audio_path:", audioPath || "(保持不变)");
    Sync.clearFetchCache(); // 上传后清缓存
    return row;
  },

  // 删除云端材料（数据 + Storage 音频）
  // ⚠️ 顺序很关键：先写「已删除墓碑」再删云端行，避免竞态导致其他端把本地副本复活
  // 删除云端材料（数据 + 音频）。
  // opts.deleteVocab:
  //   - false / undefined（默认）→ 仅删材料本身 + 音频，【保留】生词本与学习进度
  //   - true → 连同生词本(vocab)、播放进度(progress) 一起删除
  async deleteMaterial(materialId, audioPath, opts) {
    const c = await _loadClient(); if (!c || !_user) return;
    const deleteVocab = !!(opts && opts.deleteVocab);
    // 1) 先记录墓碑（让其他端在「行已删、墓碑未写」的窗口里也能看到要删）
    await Sync.markDeleted(materialId);
    // 2) 再真正删除云端数据 + 音频（材料行总是删）
    await c.from("materials").delete().eq("id", materialId).eq("user_id", _uid());
    if (deleteVocab) {
      // 仅当用户明确「连同生词本删除」时才删生词与进度，
      // 避免重载材料时丢失已学生词/进度（默认保留，符合「只删材料」的语义）
      await c.from("vocab").delete().eq("material_id", materialId).eq("user_id", _uid());
      await c.from("progress").delete().eq("material_id", materialId).eq("user_id", _uid());
    }
    if (audioPath) {
      try { await c.storage.from("audio").remove([audioPath]); } catch (e) {}
    }
    Sync.clearFetchCache(); // 删除后清缓存，确保下次拉到最新
  },

  // 删除材料时的「是否连同生词本删除」选择弹窗（library.html / index.html 共用）
  // 返回 Promise<'keep' | 'delete' | null>：
  //   'keep'   = 仅删材料（保留生词与进度）
  //   'delete' = 连同生词本、进度一起删
  //   null     = 取消
  confirmDeleteMaterial(titleText) {
    return new Promise(function (resolve) {
      var backdrop = document.createElement("div");
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;";
      var card = document.createElement("div");
      card.style.cssText = "background:var(--card,#fff);color:var(--fg,#222);max-width:360px;width:100%;border-radius:14px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:inherit;";
      var h = document.createElement("div");
      h.textContent = titleText || "删除材料";
      h.style.cssText = "font-size:16px;font-weight:700;margin-bottom:6px;";
      var p = document.createElement("div");
      p.style.cssText = "font-size:13px;line-height:1.65;opacity:.86;margin-bottom:16px;";
      p.innerHTML = "是否<b>同时删除生词本</b>？<br><br>选「仅删材料」可<b>保留已学的生词与进度</b>，之后重载材料时能继续学习，不会丢失数据。";
      var wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;";

      function done(v) {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        document.removeEventListener("keydown", onKey);
        resolve(v);
      }
      function onKey(e) { if (e.key === "Escape") done(null); }

      var bKeep = document.createElement("button");
      bKeep.textContent = "仅删材料（保留生词与进度）";
      bKeep.style.cssText = "padding:11px 12px;border-radius:10px;border:1px solid var(--accent,#3b82f6);background:var(--accent,#3b82f6);color:#fff;font-size:14px;font-weight:600;cursor:pointer;";
      bKeep.onclick = function () { done("keep"); };

      var bDel = document.createElement("button");
      bDel.textContent = "连同生词本一起删除";
      bDel.style.cssText = "padding:11px 12px;border-radius:10px;border:1px solid var(--rec,#e23);background:transparent;color:var(--rec,#e23);font-size:14px;cursor:pointer;";
      bDel.onclick = function () { done("delete"); };

      var bCancel = document.createElement("button");
      bCancel.textContent = "取消";
      bCancel.style.cssText = "padding:9px;border-radius:10px;border:none;background:transparent;color:var(--fg,#222);opacity:.55;font-size:13px;cursor:pointer;";
      bCancel.onclick = function () { done(null); };

      wrap.appendChild(bKeep);
      wrap.appendChild(bDel);
      wrap.appendChild(bCancel);
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(wrap);
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);
      document.addEventListener("keydown", onKey);
      setTimeout(function () { try { bKeep.focus(); } catch (_) {} }, 0);
    });
  },

  // 把某 materialId 写入云端的「已删除列表」（user_settings.deleted_ids）
  // 其他设备 fetchAll 会拿到这个列表，从而在本地也删掉该材料
  // 带重试：墓碑必须可靠写入，否则删除无法跨端传播（删了又被复活）
  async markDeleted(materialId) {
    const c = await _loadClient(); if (!c || !_user || !materialId) return;
    const uid = _uid();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data: cur } = await c.from("user_settings").select("deleted_ids").eq("user_id", uid).maybeSingle();
        let arr = (cur && Array.isArray(cur.deleted_ids)) ? cur.deleted_ids.slice() : [];
        if (arr.indexOf(materialId) === -1) arr.push(materialId);
        await c.from("user_settings").upsert({ user_id: uid, deleted_ids: arr });
        console.log("[Sync] markDeleted 已记录到云端:", materialId, "(attempt " + (attempt + 1) + ")");
        return;
      } catch (e) { lastErr = e; console.warn("[Sync] markDeleted 第" + (attempt + 1) + "次失败", e); }
    }
    console.warn("[Sync] markDeleted 最终失败（不影响本地删除）", lastErr);
  },

  // 清空云端的「已删除列表」（nukeAll 用）
  async clearDeletedList() {
    const c = await _loadClient(); if (!c || !_user) return;
    try { await c.from("user_settings").upsert({ user_id: _uid(), deleted_ids: [] }); } catch (e) {}
  },

  // 🧹 云端幽灵清理：把「已删除列表」里仍躺在云端 materials 表的材料彻底删掉
  // 这样被删除的材料不会每次同步都"过滤 1 个已删除"，幽灵最终自然消失
  async cleanupCloudDeleted(deletedIds) {
    if (!deletedIds || !deletedIds.length) return;
    const c = await _loadClient(); if (!c || !_user) return;
    const uid = _uid();
    for (const id of deletedIds) {
      try {
        // 先确认云端还有这行（避免无谓删除 + 顺带清 vocab/progress/音频）
        const { data: row } = await c.from("materials").select("audio_path").eq("id", id).eq("user_id", uid).maybeSingle();
        if (!row) { console.log("[Sync] cleanupCloudDeleted 云端已无:", id); continue; }
        await c.from("materials").delete().eq("id", id).eq("user_id", uid);
        await c.from("vocab").delete().eq("material_id", id).eq("user_id", uid);
        await c.from("progress").delete().eq("material_id", id).eq("user_id", uid);
        if (row.audio_path) { try { await c.storage.from("audio").remove([row.audio_path]); } catch (_) {} }
        console.log("[Sync] cleanupCloudDeleted 已清云端幽灵:", id);
      } catch (e) { console.warn("[Sync] cleanupCloudDeleted 失败:", id, e); }
    }
  },

  // 覆盖式上传某材料的生词（先删旧的再插新的，简单可靠）
  async upsertVocab(materialId, vocabArray) {
    const c = await _loadClient(); if (!c || !_user) throw new Error("未登录");
    const uid = _uid();
    // 合并式上传：先拉云端该 material 已有的生词，与本次要上传的合并（按 word 去重），再整体写回。
    // 避免「delete 全删 → 只插本地」导致其他设备（如电脑端）的生词被覆盖丢失。
    let cloudArr = [];
    try {
      const { data: existing } = await c.from("vocab").select("*").eq("user_id", uid).eq("material_id", materialId);
      cloudArr = (existing || []).map(function (r) {
        return {
          word: r.word, note: r.note, example: r.example,
          srcSentenceIdx: r.src_sentence_idx, srcText: r.src_text,
          level: r.level, reps: r.reps, due: r.due,
          ef: r.ef, interval: r.interval,
          ef_r: r.ef_r, interval_r: r.interval_r, reps_r: r.reps_r, due_r: r.due_r,
          lastReview: r.last_review, lastGrade: r.last_grade,
          createdAt: r.created_at, updatedAt: r.updated_at,
        };
      });
    } catch (e) { console.warn("[upsertVocab] 读取云端失败，仅上传本地", e); }
    // 按 word（小写）去重合并：同一材料同一词只保留一条，本地版本覆盖云端旧版
    const merged = [];
    const seen = new Set();
    // 先加入云端词条
    for (const cv of cloudArr) {
      const k = (cv.word || "").toLowerCase().trim();
      if (!k) continue;
      if (!seen.has(k)) { seen.add(k); merged.push(cv); }
    }
    // 再加入/覆盖本地词条（本地优先，因为是最新的）
    for (const v of (vocabArray || [])) {
      const k = (v.word || "").toLowerCase().trim();
      if (!k) continue;
      if (!seen.has(k)) { seen.add(k); merged.push(v); }
      else {
        // 同词已存在 → 用本地版本覆盖（更新 note/example 等）
        const idx = merged.findIndex(function (m) { return (m.word || "").toLowerCase().trim() === k; });
        if (idx >= 0) merged[idx] = Object.assign(merged[idx], v);
      }
    }
    await c.from("vocab").delete().eq("user_id", uid).eq("material_id", materialId);
    if (!merged.length) return;
    const supportsSm2 = await _vocabSupportsSm2(c, uid);
    const rows = merged.map(function (v) {
      const row = {
        user_id: uid, material_id: materialId,
        word: v.word || "", note: v.note || "", example: v.example || "",
        src_sentence_idx: v.srcSentenceIdx ?? null, src_text: v.srcText || "",
        level: v.level || 0, reps: v.reps || 0, due: v.due || null,
        last_review: v.lastReview || null, last_grade: v.lastGrade || null,
      };
      // SM-2 字段：迁移后写入，未迁移时跳过（避免 PostgREST 列不存在报错）
      // ⚠️ ef/interval 列有 NOT NULL 约束（用户 SQL 建表时指定），不可传 null → 用默认值
      if (supportsSm2) {
        row.ef = (v.ef == null) ? 2.5 : v.ef;           // SM2_EF_INIT
        row.interval = (v.interval == null) ? 1 : v.interval; // 默认 1 天
        // 反向复习调度（看释义猜词 / 例句挖空，共用「反向 SM-2」），与正向独立
        row.ef_r = (v.ef_r == null) ? 2.5 : v.ef_r;
        row.interval_r = (v.interval_r == null) ? 1 : v.interval_r;
        row.reps_r = (v.reps_r == null) ? 0 : v.reps_r;
        row.due_r = (v.due_r == null) ? 0 : v.due_r;
      }
      return row;
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
  // ⚡ 防并发：如果已经在同步中，直接返回（避免启动时多触发点导致 2-3 轮全量同步）
  async pullFromCloud() {
    if (!Sync.isAuthed()) return null;
    if (_syncLock) { console.log("[Sync] pullFromCloud 跳过（同步进行中）"); return null; }
    _syncLock = true;
    try {
    // 双向合并：先拉云端 → 合并进本地（不清本地）→ 再把云端没有的本地材料推上去
    // 这样本地独有数据不会丢、云端独有数据也能下到本地，且不会用旧版本覆盖新版本
    const data = await Sync.fetchAll();
    if (!data) return null;
    const stats = await Sync.applyCloudDataToLocal(data);
    // 把过滤后统计挂到返回值上，供 toast 展示「实际留下几个」而非「API 返回几个」
    data._syncStats = stats;
    // 云端渲染兜底：即使 IndexedDB 写入失败（如 Safari 私有模式），列表也能从云端显示
    // 仅在材料库页（library.html）执行，避免污染 vocab.html 的 #list-wrap
    if (typeof window.renderCloudList === "function" && data.materials && data.materials.length && !document.getElementById("stat-total")) {
      try { window.renderCloudList(data.materials); } catch (e) { console.warn("[Sync] renderCloudList 失败", e); }
    }
    const cloudIds = new Set((data.materials || []).map(function (m) { return m.id; }));
    const deletedIds = new Set((data.deletedIds || []).filter(Boolean));
    console.log("[Sync] pullFromCloud cloudIds:", Array.from(cloudIds), "deletedIds:", Array.from(deletedIds));
    await Sync.pushLocalAll(cloudIds, deletedIds);
    // 🧹 清掉云端还躺着的"已删除材料"幽灵（删除后不再每次同步都"过滤 N 个"）
    if (deletedIds.size) { Sync.cleanupCloudDeleted(Array.from(deletedIds)).catch(function (e) { console.warn("[Sync] cleanupCloudDeleted 异常", e); }); }
    return data;
    } finally { _syncLock = false; }
  },

  // 上传一个材料（含音频 blob）到云端
  async uploadMaterial(materialId, audioBlob, sentences, meta, title, audioName) {
    if (!Sync.isAuthed()) return null;
    return await Sync.upsertMaterial({
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
  // 仅从云端拉取某材料的生词并合并进本地（不触发材料上传/渲染），用于打开材料时即时同步
  async pullVocabOnly(materialId) {
    if (!Sync.isAuthed() || !materialId) return;
    const c = await _loadClient(); if (!c || !_user) return;
    const uid = _uid();
    const { data, error } = await c.from("vocab").select("*").eq("user_id", uid).eq("material_id", materialId);
    if (error || !data) { console.warn("[pullVocabOnly] 失败", error); return; }
    const cloudArr = data.map(function (r) {
      return {
        word: r.word, note: r.note, example: r.example,
        srcSentenceIdx: r.src_sentence_idx, srcText: r.src_text,
        level: r.level, reps: r.reps, due: r.due,
        ef: r.ef, interval: r.interval,
        ef_r: r.ef_r, interval_r: r.interval_r, reps_r: r.reps_r, due_r: r.due_r,
        lastReview: r.last_review, lastGrade: r.last_grade,
        createdAt: r.created_at, updatedAt: r.updated_at,
      };
    });
    const key = "shadowing:vocab:" + materialId;
    let local = [];
    try { local = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) { local = []; }
    // 按 word（小写）去重合并
    const merged = [];
    const seen = new Set();
    for (const cv of cloudArr) {
      const k = (cv.word || "").toLowerCase().trim();
      if (!k) continue;
      if (!seen.has(k)) { seen.add(k); merged.push(cv); }
    }
    for (const lv of local) {
      const lk = (lv.word || "").toLowerCase().trim();
      if (!lk || seen.has(lk)) continue;
      seen.add(lk);
      merged.push(lv);
    }
    localStorage.setItem(key, JSON.stringify(merged));
    console.log("[pullVocabOnly] 已合并", merged.length, "个生词到", materialId);
  },

  // 上传某材料的学习进度
  async uploadProgress(materialId, playedArr, hardArr, lastIndex) {
    if (!Sync.isAuthed()) return;
    await Sync.upsertProgress(materialId, {
      played: playedArr || [], hard: hardArr || [], lastIndex: lastIndex || 0,
    });
  },

  // 清除某材料的「音频已同步」标记，下次同步会重新上传音频（用于重新生成、或手动删了云端音频后补救）
  clearAudioSynced(materialId) {
    try { localStorage.removeItem("shadowing:audio_synced:" + materialId); } catch (_) {}
  },

  // ⚡ 紧急清理：一键删除云端+本地所有材料数据（用于清除残留/死循环）
  // 用法：控制台输入 __nuke__() 回车，或点材料库的「🧹 清除」按钮
  async nukeAll() {
    if (!Sync.isAuthed()) return { ok: false, msg: "请先登录同步账号" };
    var client = await _loadClient();
    if (!client) return { ok: false, msg: "Supabase 客户端未就绪" };
    var uid = _uid();
    var results = { deletedCloud: 0, deletedLocal: 0, errors: [] };
    try {
      // 1. 删云端 materials + vocab + progress
      var [mRes, vRes, pRes] = await Promise.all([
        client.from("materials").delete().eq("user_id", uid),
        client.from("vocab").delete().eq("user_id", uid),
        client.from("progress").delete().eq("user_id", uid),
      ]);
      if (mRes.error) results.errors.push("materials: " + mRes.error.message);
      else results.deletedCloud += (mRes.count || 0);
      if (vRes.error) results.errors.push("vocab: " + vRes.error.message);
      if (pRes.error) results.errors.push("progress: " + pRes.error.message);
    } catch (e) { results.errors.push("云端删除异常: " + e.message); }
    // 2. 删本地 IndexedDB 所有材料
    try {
      if (window._idbAll) {
        var rows = await window._idbAll();
        for (var i = 0; i < rows.length; i++) {
          try { await window._idbDelete(rows[i].id); results.deletedLocal++; } catch (_) {}
        }
      }
    } catch (e) { results.errors.push("本地删除异常: " + e.message); }
    // 3. 清理 localStorage 标记 + 云端已删列表
    try {
      localStorage.removeItem("shadowing:last_material");
      localStorage.removeItem("shadowing:deleted_ids");
      localStorage.removeItem("shadowing:synced_ids");
    } catch (_) {}
    try { await Sync.clearDeletedList(); } catch (_) {}
    results.ok = true;
    results.msg = "云端删 " + results.deletedCloud + " 条，本地删 " + results.deletedLocal + " 个";
    if (results.errors.length) results.msg += "，错误: " + results.errors.join("; ");
    return results;
  },
};

// 把云端 fetchAll 返回的数据写入本地
Sync.applyCloudDataToLocal = async function (data) {
  if (!data) return;
  // 合并「云端已删除列表」+「本地已删标记」，任何一端删过的材料，所有端都该消失
  var deletedArr = [];
  try { deletedArr = JSON.parse(localStorage.getItem("shadowing:deleted_ids") || "[]"); } catch (_) {}
  if (!Array.isArray(deletedArr)) deletedArr = [];
  // 云端同步下来的已删除列表（其他设备删的）
  var cloudDeleted = (data.deletedIds && Array.isArray(data.deletedIds)) ? data.deletedIds : [];
  var mergedDeleted = deletedArr.concat(cloudDeleted.filter(function (id) { return deletedArr.indexOf(id) === -1; }));
  try { localStorage.setItem("shadowing:deleted_ids", JSON.stringify(mergedDeleted)); } catch (_) {}
  var deletedIds = new Set(mergedDeleted);
  var synced = _loadSyncedIds();

  var kept = 0, removed = 0;
  // 🔑 关键：真正删除本地 IndexedDB 中「已被任一端删除」的材料（同步删除落到本机）
  for (const id of deletedIds) {
    try {
      const ex = await window._idbGet(id);
      if (ex) {
        await window._idbDelete(id);
        synced.delete(id);
        removed++;
        console.log("[Sync] applyCloudDataToLocal 已删除本地副本（同步删除）:", id);
      }
    } catch (_) {}
  }

  // 合并模式：只把云端有的材料写回本地（按 id 覆盖），绝不删除本地独有材料 —— 防止「云端空 → 清空本地」的数据丢失
  // 云端音频路径带进 meta，播放时直接用签名 URL（无需下载 blob，跨设备更稳）；同时把 blob 也存一份作为离线兜底
  for (const m of (data.materials || [])) {
    if (deletedIds.has(m.id)) { console.log("[Sync] applyCloudDataToLocal 跳过已删除材料:", m.id); continue; }
    const mat = {
      sentences: m.sentences || [],
      meta: Object.assign({}, m.meta || {}, { audioPath: m.audioPath || null }),
      title: m.title,
      audio: m.audioName,
    };
    // 性能优化：同步阶段【不】从云端下载音频 blob（大文件，每次同步都下载会极慢）。
    // 音频在「打开材料」时按需用签名 URL 播放；本地已有的 blob 仅作离线兜底，保留不删。
    let blob = null;
    try { const ex = await window._idbGet(m.id); if (ex && ex.audioBlob) blob = ex.audioBlob; } catch (e) {}
    try {
      console.log("[Sync] applyCloudDataToLocal 写入:", m.id, "audioPath:", m.audioPath || "(无)", "本地blob:", !!blob);
      await window._idbPut(m.id, mat, blob);
      synced.add(m.id);
      kept++;
      console.log("[Sync] applyCloudDataToLocal 写入成功:", m.id);
    }
    catch (e) { console.warn("[Sync] put material failed", m.id, e); }
  }
  // 写入 vocab（合并模式：不丢本地新增的词）
  // 直接覆盖会导致"手机刚加的词被云端旧数据覆盖"的问题
  for (const [mid, arr] of Object.entries(data.vocab || {})) {
    try {
      const key = "shadowing:vocab:" + mid;
      const localRaw = localStorage.getItem(key);
      let local = [];
      if (localRaw) { try { local = JSON.parse(localRaw); } catch (_) { local = []; } }
      // 合并：以 word（小写）为唯一标识，两边取并集（同一材料同一词只保留一条，以云端版本为准）
      const merged = [];
      const seen = new Set();
      // 先加入云端词条（作为权威源）
      for (const cv of arr) {
        const k = (cv.word || "").toLowerCase().trim();
        if (!k) continue;
        if (!seen.has(k)) { seen.add(k); merged.push(cv); }
      }
      // 再加入本地有但云端没有的词
      for (const lv of local) {
        const lk = (lv.word || "").toLowerCase().trim();
        if (!lk || seen.has(lk)) continue;
        seen.add(lk);
        merged.push(lv);
      }
      localStorage.setItem(key, JSON.stringify(merged));
      console.log("[Sync] vocab 合并写入:", mid, "云端去重", arr.length, "+ 本地新增", merged.length - Math.min(arr.length, merged.length), "=", merged.length);
    } catch (e) { console.warn("[Sync] vocab merge failed", mid, e); }
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
  _saveSyncedIds(synced);
  return { kept: kept, removed: removed, totalFetched: (data.materials || []).length };
};

// === 本地「已同步到云端」材料 ID 集合（用于识别「被其他端删除」的材料，防止复活）===
// 说明：一个材料只要曾成功上传过/下载过，就记入 synced_ids。
// 若某次拉取发现它「云端已无、但本地曾经同步过」，即可判定被其他端删除 → 删本地、不回传。
// 用 deletedIds 非空作为安全护栏：避免云端偶发返回空列表时误删本地全部材料。
function _loadSyncedIds() {
  try { var a = JSON.parse(localStorage.getItem("shadowing:synced_ids") || "[]"); return Array.isArray(a) ? new Set(a) : new Set(); } catch (_) { return new Set(); }
}
function _saveSyncedIds(set) {
  try { localStorage.setItem("shadowing:synced_ids", JSON.stringify(Array.from(set))); } catch (_) {}
}

// 把本地 IndexedDB 中所有材料推到云端（登录/同步时调用，防止本地独有数据永久留在一台设备）
// ⚠️ 关键修复：deletedIds 里的材料【只删本地、绝不回传】，彻底杜绝「删了又被复活」
Sync.pushLocalAll = async function (existingIds, deletedIds) {
  if (!Sync.isAuthed()) return;
  let rows = [];
  try { rows = (await window._idbGetAll()) || []; } catch (e) {
    console.error("[Sync] pushLocalAll _idbGetAll 失败", e);
    if (window.toast) window.toast("❌ 读取本地材料失败");
    return;
  }
  console.log("[Sync] pushLocalAll 本地材料数:", rows.length, "→ IDs:", rows.map(function(r){return r.id;}));
  if (!rows.length) { console.log("[Sync] pushLocalAll 本地无材料，跳过"); return; }
  const skip = existingIds instanceof Set ? existingIds : null;
  // 已删除集合：云端 deleted_ids + 本地标记（兜底双保险）
  const del = deletedIds instanceof Set ? new Set(deletedIds) : new Set();
  try { (JSON.parse(localStorage.getItem("shadowing:deleted_ids") || "[]") || []).forEach(function (id) { if (id) del.add(id); }); } catch (_) {}
  // 曾经成功同步到云端的本地材料 ID
  const synced = _loadSyncedIds();
  const deletedSignal = del.size > 0; // 安全护栏：仅当本轮回传确实含删除信号时才允许「缺失即删除」
  let uploaded = 0, failed = 0, removed = 0;
  for (const r of rows) {
    try {
      const id = r.id;
      if (!id) continue;
      // 🔑 关键修复：任何一端删过的材料 → 直接删本地副本，绝不回传（防止删了又被复活）
      if (del.has(id)) {
        try { await window._idbDelete(id); removed++; } catch (_) {}
        synced.delete(id);
        console.log("[Sync] pushLocalAll 命中已删除列表，删本地不回传:", id);
        continue;
      }
      const material = r.material || {};
      const blob = r.audioBlob || null;
      // 性能优化：云端已有音频则跳过音频重传（避免每次刷新/切标签都重传数 MB 音频）。
      // 仅在「本地标记为未同步」或「云端无 audio_path」时才上传。重新生成/手动删云端后会清除该标记。
      var audioSynced = false;
      try { audioSynced = localStorage.getItem("shadowing:audio_synced:" + id) === "1"; } catch (_) {}
      const uploadBlob = !!blob && !audioSynced;
      // 云端已有该材料 → 跳过材料/音频重传（保留句子与音频），但【生词仍需合并上传】：
      // 否则「本地在该材料上新增的词」永远传不上云端（之前的漏传 bug）。
      if (skip && skip.has(id)) {
        synced.add(id);
        console.log("[Sync] pushLocalAll 跳过材料重传（云端已有），合并生词:", id);
        try {
          const vb = JSON.parse(localStorage.getItem("shadowing:vocab:" + id) || "[]");
          if (vb && vb.length) await Sync.upsertVocab(id, vb);
        } catch (e) {}
        continue;
      }
      // ⚠️ 曾经同步过、但云端现在查不到 → 说明被其他端删除 → 删本地、不回传（核心防复活逻辑）
      if (synced.has(id)) {
        if (deletedSignal) {
          try { await window._idbDelete(id); removed++; } catch (_) {}
          synced.delete(id);
          console.log("[Sync] pushLocalAll 云端已无此材料（曾被同步），视为已删除，删本地不回传:", id);
          continue;
        } else {
          // 无删除信号时保守处理：保留本地、不回传也不删，等下次有明确信号再判定
          console.log("[Sync] pushLocalAll 云端缺失但无删除信号，保守保留本地:", id);
          continue;
        }
      }
      // 其余：本地新建、尚未上传 → 正常上传
      console.log("[Sync] pushLocalAll 推送:", id, "有音频:", !!uploadBlob);
      var result = await Sync.upsertMaterial({
        id: id,
        title: (material.meta && material.meta.title) || id,
        audioName: (material.meta && material.meta.audio) || "audio.mp3",
        sentences: material.sentences || [],
        meta: material.meta || {},
        audioBlob: uploadBlob ? blob : null,
      });
      console.log("[Sync] pushLocalAll 推送成功:", id, "audio_path:", result && result.audio_path);
      if (uploadBlob && result && result.audio_path) {
        try { localStorage.setItem("shadowing:audio_synced:" + id, "1"); } catch (_) {}
      }
      uploaded++;
      synced.add(id);
      try {
        const vb = JSON.parse(localStorage.getItem("shadowing:vocab:" + id) || "[]");
        if (vb && vb.length) await Sync.upsertVocab(id, vb);
      } catch (e) {}
      try {
        const pr = JSON.parse(localStorage.getItem("shadowing:progress:" + id) || "{}");
        const hd = JSON.parse(localStorage.getItem("shadowing:hard:" + id) || "[]");
        if (pr && (pr.played || pr.lastIndex)) await Sync.upsertProgress(id, pr.played || [], hd || [], pr.lastIndex || 0);
      } catch (e) {}
    } catch (e) {
      failed++;
      console.error("[Sync] pushLocalOne FAILED", r && r.id, e);
      if (window.toast) window.toast("❌ 上传失败: " + (e && e.message || String(e)));
    }
  }
  _saveSyncedIds(synced);
  console.log("[Sync] pushLocalAll 完成: 成功 " + uploaded + ", 失败 " + failed + ", 删本地(已删材料) " + removed);
  if (window.toast && uploaded > 0) window.toast("✅ 已上传 " + uploaded + " 个材料到云端" + (failed ? " (" + failed + " 个失败)" : ""));
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
      // 页面刷新按钮（PWA 推到主屏后没有浏览器刷新按钮，用这个硬刷新拿最新代码）
      html += '<button class="nav-sync-btn" id="nav-page-refresh" title="刷新页面（获取最新代码）">↻</button>';
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
          if (window.toast) window.toast("🔄 正在同步...");
          // 优先用页面自定义的 syncPullAll（index.html 有完整刷新逻辑），否则走基础 pull
          var p = typeof window.syncPullAll === "function"
            ? window.syncPullAll()
            : Sync.pullFromCloud().then(function (d) {
                if (d && d.materials) {
                  var s = d._syncStats || {};
                  var n = s.kept != null ? s.kept : d.materials.length;
                  var msg = "✅ 已同步 " + n + " 个材料";
                  if (s.removed > 0) msg += "（过滤 " + s.removed + " 个已删除）";
                  if (typeof window.toast === "function") window.toast(msg);
                  else alert(msg);
                  if (typeof window.loadVocab === "function") window.loadVocab();
                  if (typeof window.renderList === "function") window.renderList();
                } else {
                  if (typeof window.toast === "function") window.toast("⚠️ 云端无材料（本地材料将自动上传）");
                }
              });
          var done = false;
          function reset() { if (done) return; done = true; btn.disabled = false; btn.textContent = "🔄"; }
          p.finally(reset);
          // 30 秒超时兜底：无论如何恢复按钮，避免卡在 ⏳
          setTimeout(reset, 30000);
        });
      }

      // 页面刷新按钮事件：PWA 主屏无浏览器刷新入口，用这个硬刷新拿最新代码
      // 设计依据：sw.js 对导航请求（HTML）不拦截，且 Cloudflare 对 HTML 设 no-cache，
      // 因此原生 location.reload() 即取最新 index.html（无需清 SW 缓存）。
      var refreshBtn = document.getElementById("nav-page-refresh");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", function () {
          if (window.toast) window.toast("🔄 正在刷新页面...");
          // 双保险：若 SW 已激活，先触发 update（新版本 SW 会自动 skipWaiting 接管），再 reload
          try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
              navigator.serviceWorker.getRegistration().then(function (reg) {
                if (reg) { try { reg.update(); } catch (_) {} }
                location.reload();
              }).catch(function () { location.reload(); });
            } else {
              location.reload();
            }
          } catch (_) { location.reload(); }
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

/* ========== Safari 兜底：library.html 内联 JS 解析失败时直接渲染 ========== */
// 只在材料库页（library.html）生效，不污染 vocab.html / index.html
(function () {
  // 排除非材料库页面：vocab.html 有 #review-area 和 #stat-total
  if (document.getElementById("review-area") || document.getElementById("stat-total")) {
    console.log("[sync-safari-fallback] 跳过：当前不是材料库页");
    return;
  }
  // 只在材料库页生效
  var wrap = document.getElementById("list-wrap");
  if (!wrap) return;

  console.log("[sync-safari-fallback] 检测到材料库页，准备兜底渲染");

  // 工具函数
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) { try { if (window.toast) window.toast(msg); } catch(e){} return; }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 2000);
  }

  // 渲染云端材料列表
  window.renderCloudList = function (materials) {
    if (!wrap) wrap = document.getElementById("list-wrap");
    if (!materials || !materials.length) {
      wrap.innerHTML = '<div style="background:var(--panel,#fff);border:1px dashed rgba(15,23,42,.12);border-radius:18px;padding:40px 16px;text-align:center;color:#64748b;text-align:center"><div style="font-size:36px;margin-bottom:8px">☁️</div>云端暂无材料<br><small>先去「生成材料」页面拖入 MP3 音频开始第一份</small></div>';
      return;
    }
    var html = '<div style="display:flex;flex-direction:column;gap:12px">';
    for (var i = 0; i < materials.length; i++) {
      var m = materials[i];
      var meta = m.meta || {};
      var title = m.title || meta.title || m.id;
      var sentCount = (m.sentences && m.sentences.length) || 0;
      var audioName = m.audioName || meta.audio || "";
      var dateStr = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }) : "";

      html += '<div style="background:#fff;border:1px solid rgba(15,23,42,.06);border-radius:18px;padding:16px 18px;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;cursor:pointer;transition:transform .18s,box-shadow .18s" onclick="window.location.href=\'index.html?material=\' + encodeURIComponent(\'' + esc(m.id) + '\')">' +
        '<div>' +
          '<div style="font-size:16px;font-weight:700;margin-bottom:4px;word-break:break-word">' + esc(title) + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12.5px;color:#64748b">' +
            '<span style="background:#f9fafc;border:1px solid rgba(15,23,42,.06);border-radius:999px;padding:1px 9px">' + sentCount + ' 句</span>' +
            (audioName ? '<span style="background:#f9fafc;border:1px solid rgba(15,23,42,.06);border-radius:999px;padding:1px 9px">' + esc(audioName) + '</span>' : '') +
            (dateStr ? '<span style="background:#f9fafc;border:1px solid rgba(15,23,42,.06);border-radius:999px;padding:1px 9px">' + dateStr + '</span>' : '') +
            (m.audioPath ? '<span style="background:rgba(34,197,94,.06);border-color:rgba(16,185,129,.35);color:#10b981;border-radius:999px;padding:1px 9px">🎵 有音频</span>' : '') +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' +
          '<button style="font-size:12.5px;padding:5px 11px;border-radius:9px;cursor:pointer;background:linear-gradient(135deg,#3b82f6 0%,#6366f1 100%);color:#fff;border:none;font-weight:600;box-shadow:0 8px 28px rgba(59,130,246,.3)" onclick="event.stopPropagation();window.location.href=\'index.html?material=\' + encodeURIComponent(\'' + esc(m.id) + '\')">▶ 打开跟读</button>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
    wrap.innerHTML = html;

    // 更新统计
    var statTotal = document.getElementById("stat-total");
    if (statTotal) statTotal.textContent = materials.length;
    var statStarted = document.getElementById("stat-started");
    if (statStarted) statStarted.textContent = materials.length;

    console.log("[sync-safari-fallback] 兜底渲染了", materials.length, "个材料");
  };

  // 如果 Sync 已就绪且已登录，立即拉取并渲染
  if (Sync.isAuthed()) {
    console.log("[sync-safari-fallback] 已登录，立即拉取云端数据");
    Sync.fetchAll().then(function (data) {
      if (data && data.materials && data.materials.length) {
        // 过滤掉已删除材料后再渲染和提示
        var delSet = new Set((data.deletedIds || []).filter(Boolean));
        var visible = data.materials.filter(function (m) { return !delSet.has(m.id); });
        window.renderCloudList(visible);
        var msg = "✅ 已同步 " + visible.length + " 个材料";
        if (data.materials.length - visible.length > 0) msg += "（过滤 " + (data.materials.length - visible.length) + " 个已删除）";
        toast(msg);
      } else {
        wrap.innerHTML = '<div style="background:#fff;border:1px dashed rgba(15,23,42,.12);border-radius:18px;padding:40px 16px;text-align:center;color:#64748b"><div style="font-size:36px;margin-bottom:8px">📭</div>还没有保存的材料<br><small>先去「生成材料」页面拖入 MP3 音频开始第一份</small></div>';
      }
    }).catch(function (err) {
      console.warn("[sync-safari-fallback] 拉取失败", err);
    });
  } else {
    console.log("[sync-safari-fallback] 未登录，等待登录后渲染");
    // 显示空状态
    wrap.innerHTML = '<div style="background:#fff;border:1px dashed rgba(15,23,42,.12);border-radius:18px;padding:40px 16px;text-align:center;color:#64748b"><div style="font-size:36px;margin-bottom:8px">🔒</div>请先登录以同步材料<br><small>点击右上角「登录同步」按钮</small></div>';
  }

  // 监听登录事件（仅在各页面未设置 onSyncSignedIn 时才兜底，避免覆盖页面自己的登录逻辑）
  if (!window.onSyncSignedIn) {
    window.onSyncSignedIn = function () {
      console.log("[sync-safari-fallback] 检测到登录，拉取云端数据");
      Sync.fetchAll().then(function (data) {
        if (data && data.materials && data.materials.length) {
          var delSet2 = new Set((data.deletedIds || []).filter(Boolean));
          var vis2 = data.materials.filter(function (m) { return !delSet2.has(m.id); });
          window.renderCloudList(vis2);
          var msg2 = "✅ 已同步 " + vis2.length + " 个材料";
          if (data.materials.length - vis2.length > 0) msg2 += "（过滤 " + (data.materials.length - vis2.length) + " 个已删除）";
          toast(msg2);
        }
      }).catch(function (err) {
        console.warn("[sync-safari-fallback] 登录后拉取失败", err);
      });
    };
  }

  // 全局快捷：控制台输入 __nuke__() 即可一键清空云端+本地所有材料
  window.__nuke = function () { return Sync.nukeAll(); };
})();