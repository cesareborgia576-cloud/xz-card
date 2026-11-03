/* ============================================================
   《天元一界 · 外置变量补全 AI》v2.1
   来源：春日狂想曲「同层版 · MVU 变量自愈引擎 / 后台推演外置 AI」→ 适配天元一界

   干什么：
     · 主模型漏写、写坏、或者干脆没写 <UpdateVariable> 时，由外置 AI 读本楼正文，
       算出该变的变量，补出一份合规的 <UpdateVariable> 块，塞回那一楼，并把 MVU 数据写进去。
     · 送出去的提示词只有三样东西：
         ①《变量更新规则》＝变量更新规则 **＋ 变量输出格式**（v429 起格式并进细则末尾）
         ②《变量输出格式强调》＝只占位，正文没有 <JSONPatch 时不当结构送
         ③ 命中的角色速查（关键词触发，没提到的人一个字都不送）
       世界书里那几十条人设、宗门、技能总表一概不进提示词 —— 全量注入必死。

   ★ v2.0 本次唯一的重点：【缓存按存档隔离】（跟同层版最新版对齐）
     · 旧写法第一顺位用 ctx.chatId，那是「角色 id」：同一个角色开两个存档，键完全一样，
       记忆、补算记录、面板状态、各种「这一楼认过了」的指纹全部串在一起。
     · 旧写法兜底用「内容指纹」（第几楼 + 正文长度 + 尾巴）：两个都从同一张开场白开始的存档会撞键，
       新存档直接继承旧存档的补算记录与状态，玩家看到的就是「明明是新档，却有缓存」。
     · 现在一律按【存档】取键：
         存档 chat_id → 存档文件名 → 存档名
         → chat 作用域里自造的 __thChatKey（随存档保存，绝不撞车）
         → 本次页面的随机盐
       并且 1.2 秒对一次键，一变就 resetForNewChat()：内存里上一局的记录、提示词、返回、
       命中名单、扫描缓存全部丢掉，老老实实重读当前存档。

   ★ v2.1 本次唯一的重点：【嗅探时机改抄同层版·春日狂想曲 v97】
     · 旧写法：嗅探只挂在「生成结束（GENERATION_ENDED）」这一个入口上，
       换个楼层、swipe 换回复、改消息都不查；而且 is_generating 在刚点发送那一瞬还没置上，
       只能靠 `_finishedFloor`（旧实现的变量，**现已不存在**）硬闸挡着。
     · 新写法（v97）：心跳每 700ms 调 pollSniff()，函数内部按 **2 秒**节流 —— 主路；
       生成结束 / 停止 / 收到回复 → 跳过节流立刻补查一次 —— 快速通道。
       抑制靠两道闸：① 酒馆全局 is_generating；② 正文长度连续两轮不变（防漏报闸失灵）。
       异常要「二次确认」（持续 ≥1.9 秒）才真弹，避开「正文刚落地、MVU 还没解析」那一瞬。
       同一楼只提示一次（_sniffedKey 去重），切存档时 resetSniffState() 清零。
     · **嗅到异常只弹一条轻提示（toast）+ 状态栏亮 ❌ 红标**：
       绝不自动弹「🩺 变量补全」面板、绝不挂起或遮挡游戏。
       想看详情 / 想补算，玩家自己点状态栏那颗按钮才有面板。
   ============================================================ */
(function () {
  'use strict';

  /* ══════════════════ 一、默认设置与常量 ══════════════════ */
  var DEFAULTS = {
    enabled: true,            /* 总开关 */
    auto: false,              /* 每次正文生成完自动嗅探（默认关：没填接口时别空跑） */
    autoRepair: false,        /* 嗅探到缺失就自动补（默认关，先只提醒） */
    sniffer: true,            /* 实时嗅探：最新一楼缺 <UpdateVariable> 就把状态栏按钮变黄提醒 */
    /* ★★★ v446【用户 2026-10-29 定的】：「一进卡第一瞬间就是疯狂调动 api 去生成那些事件，
       你让玩家自己按啊」。
       这里原来是 true，而且理由写得很像回事（"世界一直在动，要玩家手动点就等于没做"）。
       但实际后果是一进卡就发请求，原因有两层，都不是"到点了"：
         ① 酒馆打开存档时会**批量重放历史楼层**，每层都触发 MESSAGE_RECEIVED，
            而那时讯刷新的入口就挂在这个事件上 —— 于是开卡瞬间连问好几次；
         ② 判断「该不该刷」靠两个日期变量（热议那天 / 闲杂那天），
            新存档这两个值是空的 ⇒ 恒判「从来没刷过」 ⇒ 第一次必然真发请求。
       ⇒ 现在**默认关，且永不自动**：只有玩家自己在「目前事件」页点刷新才走。
         这个设置项保留（老存档里可能存着 true，见下面对它的强制迁移），
         但自动触发那段已经整段删掉，开着也不会自己跑。 */
    tickerAuto: false,
    apiMode: 'main',          /* main = 走酒馆自己的模型（不用填 key）；custom = 另填接口 */
    temperature: 0.2,         /* 变量计算要稳，温度压低 */
    maxTokens: 1600,
    wantAnalysis: true,       /* 要求 AI 写 <Analysis>（变量细则本来就要） */
    devMode: false,           /* 开发者模式：面板摊开提示词与原始返回 */
    keepMemory: true,         /* 折叠进提示词的「本轮已发生的关键事件」，按存档存 */
    memMax: 5,
    timeoutMs: 60000,
    /* 只走 custom 通道时才用 */
    base: 'https://api.openai.com/v1',
    key: '',
    model: 'gpt-4o-mini'
  };

  var KEY_SETTINGS = 'xzVarCompleteSettings';
  var KEY_HIST = 'xzVarCompleteHist::';       /* 每个存档一份 */
  /* ★ v397b：删掉了 `var KEY_MEM = 'xzVarCompleteMem::';` —— 全文件零引用。
     ⚠ 它和 KEY_HIST 长得几乎一样、注释也一样（「每个存档一份」），
       这种"孪生常量"最容易被下一个维护者当成"存档记忆"误接上，
       然后写出一个**从来没被写过、永远读回空**的功能。留着没有收益，只有风险。 */
  /* ★ v389：拉到的模型列表也必须落盘。
     原来 `S.models` 只在内存里，而 `resetForNewChat`（换存档）会把它清成 null
     ⇒ 豆包玩家每次换存档/刷新，下拉框又变空、又得再点一次「拉取模型」、
     又只会拿到那条「它没有 /models 接口」的报错 —— 看上去就是「永远填不了」。
     模型列表跟服务商走、不跟存档走，所以**不带存档键**，全局一份。 */
  var KEY_MODELS = 'xzVarCompleteModels';
  var INJECT_NAME = 'script_inject_xz_var_complete';

  var S = {
    settings: null,
    models: null,
    running: false,
    status: 'idle',            /* idle | running | ok | bad | warn */
    statusText: '待机',
    lastPrompt: '', lastSystem: '', lastRaw: '',
    lastNpcs: [], lastMissing: false,
    history: [],
    panel: null,
    chatKey: null,
    wbCache: null,             /* {at, rules, format, rosterIndex} */
    pendingTimer: null
  };

  /* ══════════════════ 二、环境探针 ══════════════════ */
  function windows() {
    var out = [];
    try { if (typeof window !== 'undefined') out.push(window); } catch (e) {}
    try { if (window.parent && out.indexOf(window.parent) < 0) out.push(window.parent); } catch (e) {}
    try { if (window.top && out.indexOf(window.top) < 0) out.push(window.top); } catch (e) {}
    for (var i = 0; i < out.length; i++) {
      try {
        var iframes = out[i].document.querySelectorAll('iframe');
        for (var j = 0; j < iframes.length; j++) {
          var cw = null;
          try { cw = iframes[j].contentWindow; } catch (e2) { cw = null; }
          if (cw && out.indexOf(cw) < 0) out.push(cw);
        }
      } catch (e3) {}
    }
    return out;
  }
  function findUiDoc() {
    var list = windows(), i, dd;
    for (i = 0; i < list.length; i++) {
      try {
        dd = list[i].document;
        if (dd && dd.getElementById && (dd.getElementById('xz-overlay') || dd.getElementById('chat'))) return dd;
      } catch (e) {}
    }
    for (i = list.length - 1; i >= 0; i--) {
      try { dd = list[i].document; if (dd && dd.body) return dd; } catch (e) {}
    }
    try { if (typeof document !== 'undefined' && document && document.body) return document; } catch (e2) {}
    return null;
  }
  function doc() { return findUiDoc(); }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) {}
    return null;
  }
  function clamp(n, a, b) { n = Number(n); if (isNaN(n)) return a; return Math.min(b, Math.max(a, n)); }
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* ★ v76：可传第三个参数指定停留毫秒数（缺省仍是 3800ms）—— 老调用点不受影响。 */
  function toast(msg, type, ms) {
    var life = (typeof ms === 'number' && ms > 0) ? ms : 3800;
    var toastrTriggered = false;
    try {
      var wList = windows();
      for (var i = 0; i < wList.length; i++) {
        var w = wList[i];
        if (w && w.toastr) {
          if (type === 'error' && typeof w.toastr.error === 'function') { w.toastr.error(msg); toastrTriggered = true; break; }
          else if (type === 'warning' && typeof w.toastr.warning === 'function') { w.toastr.warning(msg); toastrTriggered = true; break; }
          else if (type === 'success' && typeof w.toastr.success === 'function') { w.toastr.success(msg); toastrTriggered = true; break; }
          else if (typeof w.toastr.info === 'function') { w.toastr.info(msg); toastrTriggered = true; break; }
        }
      }
    } catch (e) {}
    try {
      var d = doc(); if (!d || !d.body) return;
      var n = d.createElement('div');
      n.className = 'xz-varc-toast-banner';
      n.textContent = msg;
      var bg = type === 'error' ? 'rgba(220,38,38,.96)' : (type === 'warning' ? 'rgba(217,119,6,.96)' : (type === 'success' ? 'rgba(16,185,129,.96)' : 'rgba(15,23,42,.96)'));
      n.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483647;background:' + bg +
        ';color:#ffffff;padding:10px 20px;border-radius:8px;font-size:13.5px;font-weight:700;letter-spacing:.5px;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.75);border:1.5px solid rgba(255,255,255,.3);pointer-events:none;max-width:92vw;text-align:center;line-height:1.5;';
      d.body.appendChild(n);
      setTimeout(function () { try { n.remove(); } catch (e2) {} }, life);
    } catch (e3) {}
  }

  /* ★ v76：原来那张「格式异常大红提示条」已撤 —— 改抄《同层版·春日狂想曲》v97，
     嗅到异常只弹一条轻提示（toast），不再立任何常驻 DOM。 */
  function st() {
    try { if (window.SillyTavern) return window.SillyTavern; } catch (e) {}
    try { var t = window.parent || window.top; if (t && t.SillyTavern) return t.SillyTavern; } catch (e2) {}
    return null;
  }
  function getContext() {
    var s = st();
    try { if (s && typeof s.getContext === 'function') return s.getContext(); } catch (e) {}
    try {
      var t = window.parent || window.top;
      if (t && t.SillyTavern && typeof t.SillyTavern.getContext === 'function') return t.SillyTavern.getContext();
    } catch (e2) {}
    return null;
  }
  function chatArray() {
    try { var c = getContext(); if (c && Array.isArray(c.chat)) return c.chat; } catch (e) {}
    return [];
  }
  /* 取一条消息的当前正文（认 swipe） */
  function msgText(m) {
    if (!m || typeof m !== 'object') return '';
    var swId = m.swipe_id != null ? m.swipe_id : 0;
    if (m.swipes && m.swipes.length) {
      var sw = m.swipes[swId];
      if (sw && typeof sw === 'object' && typeof sw.mes === 'string') return String(sw.mes);
      if (typeof sw === 'string') return sw;
    }
    return String(m.mes || '');
  }

  /* ══════════════════ 三、★ 缓存核心：按键按存档，换档即冷启动 ══════════════════ */
  /* 这一节就是本次「同一个缓存问题」的正解，跟同层版最新版逐字对齐。
     优先级：ST 活跃聊天文件 (ch.chat / ctx.chatId) → 存档 chat_id → 存档文件名 → 存档名 → chat 作用域自造键 → 本次页面随机盐。
     绝对不许再用「角色 id」，也绝对不许再用「内容指纹」。 */
  function chatId() {
    try {
      var ctx = getContext();
      if (ctx) {
        var m = ctx.chat_metadata || (typeof window !== 'undefined' ? window.chat_metadata : null) || {};
        if (m.chat_id) return String(m.chat_id);
        if (m.file_name) return String(m.file_name);
        if (m.name) return String(m.name);

        /* 兜底键改成「每个存档唯一」：先在 chat 作用域里存一个自造 key（随存档一起保存），
           拿不到才退回本次页面的随机串 —— 绝不再用「内容指纹」
           （两个同开场的存档会撞键，于是新存档继承了旧存档的补算记录与状态，看着就是「有缓存」）。 */
        try {
          if (typeof getVariables === 'function' && typeof insertOrAssignVariables === 'function') {
            var g = getVariables({ type: 'chat' }) || {};
            if (g.__xzChatKey) return String(g.__xzChatKey);
            var nk = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            insertOrAssignVariables({ __xzChatKey: nk }, { type: 'chat' });
            return nk;
          }
        } catch (eK) {}

        try {
          if (!window.__xzSessionSalt) window.__xzSessionSalt = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          return window.__xzSessionSalt;
        } catch (eS) {}

        var ch = ctx.characters?.[ctx.characterId];
        if (ch && ch.chat) return 'ch::' + String(ch.chat);
        if (ctx.chatId) return 'ch::' + String(ctx.chatId);
        if (ctx.characterId != null) return 'cid::' + String(ctx.characterId);
      }
    } catch (e) {}
    return 'default';
  }

  function histKey() { return KEY_HIST + S.chatKey; }

  /* 换存档 / 读别的存档时，把上一局留在内存里的东西全部清掉，让它老老实实重读当前存档 */
  function resetForNewChat(quiet) {
    try { S.history = []; } catch (e0) {}
    try {
      S.lastPrompt = ''; S.lastSystem = ''; S.lastRaw = '';
      S.lastNpcs = []; S.lastMissing = false;
      S.status = 'idle'; S.statusText = '待机（已换存档）';
    } catch (e1) {}
    try { S.wbCache = null; } catch (e2) {}          /* 世界书缓存也丢，重新读 */
    /* ★ v389：这里**不许**清成 null。模型列表跟服务商走、不跟存档走 ——
       清掉就等于豆包玩家每换一次存档，下拉框又空一次（见 KEY_MODELS 处的说明）。
       从磁盘读回来；真没有才留 null，那时面板上本来也不画下拉框。 */
    try { S.models = loadModels(); } catch (e3) {}
    try { if (S.pendingTimer) { clearTimeout(S.pendingTimer); S.pendingTimer = null; } } catch (e4) {}
    try { S.running = false; } catch (e5) {}
    /* 外置补全注入到酒馆的那条提示词，属于上一局，撤掉 */
    try { if (typeof uninjectPrompts === 'function') uninjectPrompts([INJECT_NAME]); } catch (e6) {}
    try { var s = st(); if (s && s.extensionPrompts) delete s.extensionPrompts[INJECT_NAME]; } catch (e7) {}
    try { resetSniffState(); } catch (e8) {}
    notifyStatus();
    if (S.panel) renderPanel();
    if (!quiet) console.log('[外置变量补全] 已换存档，上一局缓存全部归零：' + S.chatKey);
  }

  var _chatKeySeen = null;
  function watchChatSwitch() {
    var now = chatId();
    if (_chatKeySeen === null) { _chatKeySeen = now; S.chatKey = now; return false; }
    if (now === _chatKeySeen) return false;
    _chatKeySeen = now;
    S.chatKey = now;
    resetForNewChat();
    return true;
  }

  /* ══════════════════ 四、世界书取料：只要规则、格式、人物速查索引 ══════════════════ */
  /* ★ getWorldbook 返回的是 Promise（不是数组）。旧脚本直接 Array.isArray 判，
     永远判假，于是「读世界书」这条路一直是死的，只能吃内置兜底。这里全部 Promise 化。 */
  function worldbookNames() {
    var names = [];
    try {
      if (typeof getCharWorldbookNames === 'function') {
        var bn = getCharWorldbookNames('current');
        if (bn && bn.primary) names.push(bn.primary);
        if (bn && Array.isArray(bn.additional)) bn.additional.forEach(function (x) { if (x) names.push(x); });
      }
    } catch (e) {}
    if (!names.length) {
      try { if (typeof getWorldbookNames === 'function') names = getWorldbookNames() || []; } catch (e2) {}
    }
    return names;
  }

  function fetchWorldbookEntries() {
    return new Promise(function (resolve) {
      var names = worldbookNames();
      if (!names.length || typeof getWorldbook !== 'function') { resolve([]); return; }
      var all = [], left = names.length, done = false;
      function finish() { if (!done) { done = true; resolve(all); } }
      names.forEach(function (nm) {
        var p;
        try { p = getWorldbook(nm); } catch (e) { p = null; }
        if (!p || typeof p.then !== 'function') {
          if (Array.isArray(p)) all = all.concat(p);
          if (--left <= 0) finish();
          return;
        }
        p.then(function (list) {
          if (Array.isArray(list)) all = all.concat(list);
          if (--left <= 0) finish();
        }).catch(function () { if (--left <= 0) finish(); });
      });
      /* 兜底：接口卡住时别让面板一直转。
         注意只在「一条都没回来」时才提前收工 —— 早收工会把半份世界书当成完整的缓存住，
         之后提示词就一直是残的。 */
      setTimeout(function () { if (!all.length) finish(); }, 5000);
      setTimeout(finish, 15000);
    });
  }

  function entryName(e) { return String((e && (e.name || e.comment)) || ''); }
  function entryContent(e) { return String((e && e.content) || ''); }

  /* 世界书缓存：换存档必丢（resetForNewChat）、世界书更新事件也丢、手动刷新也丢。
     —— 缓存的失效点写清楚，免得又变成「改了世界书脚本却还在用旧的」那类怪事。 */
  function loadWorldbook(force) {
    if (!force && S.wbCache) return Promise.resolve(S.wbCache);
    return fetchWorldbookEntries().then(function (list) {
      var rules = '', format = [], roster = '';
      list.forEach(function (e) {
        if (!e) return;
        var nm = entryName(e);
        if (!rules && nm.indexOf('变量更新规则') >= 0) rules = entryContent(e).trim();
        if (!rules && nm.indexOf('变量更新规则') >= 0) rules = entryContent(e).trim();
        /* ★ v429：只收**真带结构**的条目。
           现在完整格式已经并进《变量更新规则》，剩下那条《变量输出格式强调》正文只有
           `<UpdateVariable> ... </UpdateVariable>` 这种占位壳 —— 它当"结构照抄"送进去，
           模型会照着输出三个点。判据：正文里必须有 <JSONPatch，否则跳过。
           ★★★ v431：这条判据会让 format 永远是空的（结构就在《变量更新规则》里面，
             而那个条目已经被上面的 rules 收走了），于是：
               · 状态栏徽章恒显示「格式 ✘」—— 而实际格式是齐的，等于仪表在骗人；
               · buildPrompt 掉进 else 分支，塞进去一个**只有 replace** 的示例
                 （`[{"op":"replace","path":"/时间/精确时间","value":"08:30"}]`），
                 与细则里"只认 replace/delta/insert/remove 四个操作"正好对不上。
             ⇒ 判据改成：**规则条目本身带了 <JSONPatch 就算格式已满足**，
               把这段文本当成"格式已在规则里"的证据，不再重复塞一遍。 */
        if (nm.indexOf('变量输出格式') >= 0) {
          var c = entryContent(e).trim();
          if (c && c.indexOf('<JSONPatch') >= 0) format.push({ name: nm, content: c });
        }
        if (!roster && nm.indexOf('人物总览') >= 0) roster = entryContent(e).trim();
      });
      /* 规则条目里已经含完整输出结构 ⇒ 视为"格式已覆盖"，无需额外条目 */
      var fmtInRules = !!(rules && rules.indexOf('<JSONPatch') >= 0);
      format.sort(function (a, b) { return a.name.length - b.name.length; });   /* 主格式在前，强调在后 */
      S.wbCache = { at: Date.now(), rules: rules, format: format, fmtInRules: fmtInRules, roster: roster, count: list.length };
      return S.wbCache;
    }).catch(function () {
      S.wbCache = { at: Date.now(), rules: '', format: [], fmtInRules: false, roster: '', count: 0 };
      return S.wbCache;
    });
  }

  /* 人物速查索引：从《人物总览》那种「- 姓名｜性别｜境界·玄元属性｜身份」的行里切出来。
     切不出来就用内置兜底表（见下）。 */
  var ROSTER_FALLBACK = [
    '待初始化｜主角｜火',   /* v408：同 05 的兜底——没填名字时不冒用「火岚」 */
    '沈清颜｜女｜玄枢后期·冰｜散修孤峰刀修（清冷寡言，随身霜牙，走刀道流血路）',
    '周铁山｜男｜玄枢中期·冰｜铁剑门客卿（老练势利，讲究门面，持重锋铁剑）',
    '司幽怜｜女｜尊玄初期·水｜幽月仙宫宗主（慵懒知性，极尽拉扯）',
    '云疏月｜女｜尊玄后期·雷｜幽月仙宫首席客卿（超然清冷，一心向道）',
    '陆昭华｜女｜尊玄初期·冰｜霜霄仙阙昭华圣女（高冷傲娇，刻薄毒舌，极度护短）',
    '梵清仪｜女｜尊玄初期·冰｜霜霄仙阙素心尊者（熟美丰腴，三无面瘫）',
    '白长雪｜女｜尊玄初期·冰｜天云雪山雪仙（赤眸三无，内心闷骚，抚育之恩）',
    '言清漪｜女｜玄枢后期·水｜司天监掌星弟子（白布遮目，温婉知性）',
    '沈千金｜女｜玄枢初期·水｜千机坊市千宝楼楼主（精明财迷，掌黑市）',
    '姜绾绾｜女｜凝府期｜三剑宗弟子（青绿仙裳，背负灭门血仇）',
    '药仙儿｜女｜凝府初期·木｜青木药宗药童（呆萌认真，怀上古残方）',
    '苏小玲｜女｜凝府期·木｜盎然之林灵植妖修（九叶聚灵草化形）',
    '厉无涯｜男｜凝府后期·火｜煞血门少门主（修血煞魔功）',
    '宋仁德｜男｜凝府中期·土｜铁剑门首席弟子（势利刻薄）',
    '叶凌天｜男｜玄枢初期·冰｜太一门首席真传大天骄',
    '洛无尘｜女｜玄枢后期·冰｜太一门圣女',
  ];

  function parseRoster(text) {
    var map = {};      /* 名 → 一行速查 */
    var alias = {};    /* 别名 → 正名 */
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var t = String(line || '').replace(/^\s*[-*·•\d.、)\s]+/, '').trim();
      if (!t || t.charAt(0) === '#') return;
      /* 「陆玄机｜男｜尊玄后期·冰｜宗主（…）」 */
      if (t.indexOf('｜') < 0 && t.indexOf('|') < 0) return;
      if (t.indexOf('：') >= 0 && t.indexOf('｜') > t.indexOf('：')) return;
      var parts = t.split(/[｜|]/).map(function (x) { return x.trim(); });
      if (parts.length < 2) return;
      var name = parts[0].replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '');
      if (!/^[\u4e00-\u9fa5A-Za-z·]{2,8}$/.test(name)) return;
      if (map[name]) return;
      map[name] = t;
      /* 从「铁剑门客卿·周铁山」这种复合名里切别名 */
      var seg = name.split(/[·・]/);
      if (seg.length > 1) {
        var tail = seg[seg.length - 1];
        if (tail.length >= 2 && !alias[tail]) alias[tail] = name;
      }
    });
    return { map: map, alias: alias };
  }

  /* ══════════════════ 五、关键词触发：只送这一楼真提到的人 ══════════════════ */
  function readState() {
    var merged = null;
    var cands = windows();
    for (var i = 0; i < cands.length && !merged; i++) {
      try {
        var w = cands[i];
        var m = w && w.Mvu;
        if (m && typeof m.getMvuData === 'function') {
          var d = m.getMvuData({ type: 'message', message_id: 'latest' });
          var b = d && (d.stat_data || d.sata_data);
          if (b && typeof b === 'object') merged = JSON.parse(JSON.stringify(b));
        }
      } catch (e) {}
    }
    if (!merged) {
      try {
        if (typeof getVariables === 'function') {
          var v = getVariables({ type: 'chat' }) || {};
          merged = v.stat_data || v;
        }
      } catch (e2) {}
    }
    return merged || {};
  }

  var NAME_STOP = { '主角': 1, '自己': 1, '长老': 1, '执事': 1, '弟子': 1, '宗主': 1, '圣女': 1, '客卿': 1, '真人': 1, '道友': 1 };

  function scanNpcs(texts, sd) {
    var roster = (S.wbCache && S.wbCache.roster) || '';
    var parsed = parseRoster(roster);
    var map = parsed.map, alias = parsed.alias;
    if (!Object.keys(map).length) {
      /* 世界书没读到：用兜底表的「名字｜…」行，同样解析 */
      var fb = parseRoster(ROSTER_FALLBACK.map(function (x) { return '- ' + x; }).join('\n'));
      map = fb.map; alias = fb.alias;
    }
    var hit = [], seen = {};
    var all = (texts || []).join('\n');

    function push(name, line, why) {
      if (!name || seen[name] || NAME_STOP[name]) return;
      seen[name] = true;
      hit.push({ name: name, line: line, why: why });
    }

    /* ① 正文里真出现过的（含别名） */
    Object.keys(map).forEach(function (n) {
      if (all.indexOf(n) >= 0) push(n, map[n], '正文提及');
    });
    Object.keys(alias).forEach(function (a) {
      if (all.indexOf(a) >= 0) push(alias[a], map[alias[a]], '正文提及');
    });

    /* ② 变量里在场状态 = true 的（在玩家当前所在场景里的人，参数要给准）
       ★★★ v477：`在场状态 === true` **只表示"跟玩家处在同一场景"**，不是"每楼都要出场"。
       以前这里的数据会作为「在场人物」注入给模型，配合《事件总表》老版第 1.5 条
       「在场人物必须真出现」⇒ 模型把★名单当成**出场花名册**，姜绾绾在开局被写成
       `在场状态: true` 之后就没有东西把它置回 false，于是玩家离开三剑宗、跑到别的州，
       她仍然每楼乱入。真因是**语义被读歪**，不是变量写错。
       ⇒ 注入时把话说明白：这是"同一场景里的人"，**不是必须出场的人物**，
         主角换地方就应当没人或只有本地人，**严禁强行卷入**（作者 2026-11-02 定的口径：
         这条约束就写在这里，别处不再单独立条目）。 */
    var people = sd && sd.人物列表;
    if (people && typeof people === 'object') {
      Object.keys(people).forEach(function (n) {
        var r = people[n] || {};
        if (r.在场状态 !== true) return;
        if (map[n]) push(n, map[n], '在场');
        else {
          var seg = [];
          if (r.境界) seg.push(r.境界);
          /* ★ v81：`玄元属性.品质` v43 已废除，读它恒 undefined。
             只在真有值（老存档）时才拼，新卡不要那个空后缀。 */
          if (r.玄元属性 && r.玄元属性.属性) seg.push(r.玄元属性.属性 + (r.玄元属性.品质 ? (r.玄元属性.品质) : ''));
          if (r.势力) seg.push(r.势力);
          if (r.性格) seg.push(r.性格);
          push(n, n + '｜' + (seg.join('·') || '在场人物'), '在场');
        }
      });
    }
    /* ③ 正文里冒出来、但两张表都没有的新名字：只报名字，让 AI 自己按正文建卡 */
    var novel = all.match(/[\u4e00-\u9fa5]{2,4}(?=（|：|·|｜|\s*说道|\s*道：|\s*喝道)/g) || [];
    novel.forEach(function (n) {
      var nm = n.replace(/[（：·｜\s].*$/, '');
      if (!nm || seen[nm] || map[nm]) return;
      if (all.indexOf(nm) < 0) return;
      push(nm, nm + '｜（新出场，正文未给设定，按正文归纳身份）', '新出场');
    });

    return hit;
  }

  /* ══════════════════ 六、变量快照（给 AI 看现状，别让它瞎猜） ══════════════════ */
  function snapshotText(sd) {
    sd = sd || readState();
    var t = sd.时间 || {}, g = sd.地理 || {};
    var h = sd.主角信息 || {};
    var people = sd.人物列表 || {};
    var bag = sd.背包 || {};
    var out = [];
    out.push('【当前变量快照】');
    out.push('- 时间：' + (t.日期 || '1年1月1日') + ' ' + (t.精确时间 || '06:00'));
    out.push('- 地理：' + (g.大位置 || '未知') + ' · ' + (g.小位置 || '未知'));
    /* ★ v1.052：这行删掉 —— 战斗状态是**斗法流程内部**的旗子，
       报给模型看等于邀请模型去写它（作者：「战斗状态变量没有删除」）。 */
    out.push('- 主角：' + (h.姓名 || '未命名') + '｜境界 ' + (h.境界 || '?') +
      '｜气血 ' + (h.气血 == null ? '?' : h.气血) + '/' + (h.气血上限 == null ? '?' : h.气血上限) +
      '｜经验 ' + (h.经验值 == null ? '?' : h.经验值) + '｜可用四维点 ' + (h.可用四维点 == null ? '?' : h.可用四维点));
    out.push('- 主角武器：' + ((h.装备武器 && h.装备武器.武器名) || '无'));
    var names = Object.keys(people);
    if (names.length) {
      /* ★★★ v477：这句原来是「在场状态=★ 的要重点看」，模型把它读成
         「★ 的人每楼都该出场」⇒ 主角走到天涯海角，★ 名单照旧跟着上台。
         现在明说是「同一场景」而不是「必须出场」，并且把当前地点写在旁边当对照：
         主角不在这个势力/地点，同名的人就不该出现。 */
      out.push('- 人物列表（★ = 与主角同一场景，**不是必经出场名单**；· = 不在当前场景，不许凭空写他出现）：');
      out.push('- ‼ 判据：上面这行「地理」就是主角所在。★ 只说明"上一楼他在同一场景"，'
        + '主角换地方之后 ★ 会自动失效（脚本按地点与势力清），不许拿 ★ 当出场理由。');
      names.slice(0, 24).forEach(function (n) {
        var r = people[n] || {};
        var parts = [];
        parts.push((r.在场状态 === true ? '★' : '·') + n);
        if (r.境界) parts.push('境界' + r.境界);
        /* ★ v272（用户 2026-10-20）：`好感度` **恢复上线**（0~100，默认 50，模型写、脚本只读）。
           摘要里带上它，模型补算时能看到「这个人现在对主角什么态度」，不会瞎写。 */
        if (r.好感度 != null) parts.push('好感' + r.好感度);
        /* ★ v1.052：摘要里带上「关系」，模型补算时知道这个人是谁。 */
        if (r.关系) parts.push('关系' + r.关系);
        /* ★ v77：删掉 `if (r.伤势状态) parts.push('伤势'+ …)` —— schema 的 /人物列表 下从没有这个字段，
           恒不触发，纯死代码（且主角侧字段已整体废除）。NPC 伤势改看 气血/气血上限 的比值。 */
        if (r.气血 != null && r.气血上限) {
          parts.push('气血' + Math.round(r.气血) + '/' + Math.round(r.气血上限)
            + '(' + Math.round(Math.max(0, r.气血) / Math.max(1, r.气血上限) * 100) + '%)');
        }
        out.push('    ' + parts.join(' '));
      });
    } else out.push('- 人物列表：（空）');
    var items = Object.keys(bag);
    if (items.length) out.push('- 背包：' + items.slice(0, 20).map(function (k) {
      var b = bag[k] || {}; return k + '×' + (b.数量 == null ? 1 : b.数量);
    }).join('、'));
    /* ★ v292：任务摘要要让模型看见 —— 否则它每楼都会"忘掉"玩家手上有活。
       ⚠ 这里**不再报功勋**：功勋是背包里的一条材料（/背包/{某家功勋}），
         在背包那一行已经会列出来，再单开一行「功勋：N」等于又造了一套口径。 */
    var tk = sd.任务 || {};
    var doing = Object.keys(tk.进行中 || {});
    if (doing.length) {
      out.push('- 进行中的任务（' + doing.length + '）：');
      doing.slice(0, 10).forEach(function (k) {
        var t = (tk.进行中 || {})[k] || {};
        /* ★ v296：「进度」字段已删，快照里不再打百分比（打了就是对模型说「这个字段还在」）。 */
        out.push('  · ' + k + '｜' + (t.阶 || '黄阶') + '·' + (t.来源 || '宗门')
          + (t.地点 ? '｜' + t.地点 : '') + (t.目标 ? '｜' + t.目标 : ''));
      });
    }
    return out.join('\n');
  }

  /* ══════════════════ 七、正文与变量块的分离 ══════════════════
     ★★★ v308（玩家报的两个事故，同一个根因：**没把思维链当外人**）★★★
     事故一「一直说格式错误，这不是没错吗」：
       思维链里只要**提到**标签名 —— 模型规划格式时几乎必然要提「我要输出 <UpdateVariable>，
       <JSONPatch> 里只能放数组」—— `hasCompletePatch` 就从思维链里那个 <JSONPatch>
       一路贪到正文里真的 </JSONPatch>，中间夹着半句人话 ⇒ JSON.parse 必失败 ⇒ 判「格式错误」。
       那一楼的 <UpdateVariable> 其实**完全合规**。
     事故二「补全后把我 <think> 删掉了，很严重」：
       `stripVarBlocks` 三条正则都带 `(?:</tag>|$)` 兜底，起点又不限位置 ——
       只要思维链里出现过这几个字样（哪怕只是半截 `<Analysis`，那个 `[^>]*` 会一路
       吃进 `</think>` 的 `>`），匹配就从思维链内部开始、吃到真块的收尾，
       `</think>` 与中间正文统统被剥掉 ⇒ writeBack 再把新块拼到末尾 ⇒ 思维链没了。
     正解：先把思维链整段**遮住**，在遮罩上找标签、抠块，抠完把思维链**原样贴回**。
       遮罩用不可打印的 \u0001 包住序号，正常正文绝不可能出现。 */
  var XZ_REASON_TAGS = 'think|thinking|reasoning|thought|reflection|commentary';
  function maskReasoning(s) {
    var src = String(s || '');
    var chunks = [];
    var re = new RegExp('<\\s*(?:' + XZ_REASON_TAGS + ')\\b[^>]*>', 'ig');
    var out = '', last = 0, m;
    while ((m = re.exec(src)) !== null) {
      var openAt = m.index;
      var tag = (/^<\s*([A-Za-z]+)/.exec(m[0]) || [])[1] || 'think';
      var closeRe = new RegExp('<\\s*\\/\\s*' + tag + '\\s*>', 'ig');
      closeRe.lastIndex = openAt + m[0].length;
      var cm = closeRe.exec(src);
      var end;
      if (cm) {
        end = cm.index + cm[0].length;
      } else {
        /* 未闭合（还在流 / 模型忘了收尾）：只遮到变量块前，别把真变量块一起遮没 */
        var rel = src.slice(openAt).search(/<\s*(?:UpdateVariable|JSONPatch|json_?patch)\b/i);
        end = rel >= 0 ? openAt + rel : src.length;
      }
      if (end <= last) continue;
      out += src.slice(last, openAt);
      chunks.push(src.slice(openAt, end));
      out += '\u0001RK' + (chunks.length - 1) + '\u0001';
      last = end;
      re.lastIndex = end;
    }
    out += src.slice(last);
    return { text: out, chunks: chunks };
  }
  function unmaskReasoning(masked, chunks) {
    var s = String(masked || '');
    if (!chunks || !chunks.length) return s;
    return s.replace(/\u0001RK(\d+)\u0001/g, function (_, i) {
      var v = chunks[Number(i)];
      return v == null ? '' : v;
    });
  }
  /* 只看「模型正式写的那部分」：思维链里的一切都不算数 */
  function withoutReasoning(s) { return maskReasoning(s == null ? '' : s).text; }

  function stripVarBlocks(text) {
    var mk = maskReasoning(text);
    var s = mk.text;
    s = s.replace(/<\s*UpdateVariable\b[^>]*>[\s\S]*?(?:<\s*\/\s*UpdateVariable\s*>|$)/gi, '');
    s = s.replace(/<\s*(?:JSONPatch|json_?patch)\b[^>]*>[\s\S]*?(?:<\s*\/\s*(?:JSONPatch|json_?patch)\s*>|$)/gi, '');
    s = s.replace(/<\s*Analysis\b[^>]*>[\s\S]*?(?:<\s*\/\s*Analysis\s*>|$)/gi, '');
    return unmaskReasoning(s, mk.chunks).trim();
  }
  function hasCompletePatch(text) {
    if (!text) return false;
    /* ★ v308：只在思维链**之外**找块；且把每一个 <JSONPatch> 都试一遍 ——
       旧写法只取第一个，思维链里一段草稿就能把整楼判成「未闭合」。 */
    var s = withoutReasoning(text);
    var re = /<\s*(?:JSONPatch|json_?patch)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:JSONPatch|json_?patch)\s*>/ig;
    var bodies = [], m;
    while ((m = re.exec(s)) !== null) bodies.push(m[1]);
    for (var i = bodies.length - 1; i >= 0; i--) {
      try {
        var arr = JSON.parse(String(bodies[i]).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim());
        if (Array.isArray(arr)) return true;
      } catch (e) { /* 这一段不像话，看下一段 */ }
    }
    return false;
  }
  function latestAiIndex() {
    var chat = chatArray();
    for (var i = chat.length - 1; i >= 0; i--) {
      var m = chat[i];
      if (m && !m.is_user && !m.is_system && m.role !== 'user') return i;
    }
    return -1;
  }
  function latestUserIndexBefore(idx) {
    var chat = chatArray();
    for (var i = idx - 1; i >= 0 && i >= idx - 4; i--) {
      var m = chat[i];
      if (m && (m.is_user || m.role === 'user')) return i;
    }
    return -1;
  }

  /* ══════════════════ 八、提示词：只送规则 + 格式 + 命中的人 ══════════════════ */
  function buildPrompt(mode, sd, prose, extraHistory) {
    var wb = S.wbCache || { rules: '', format: [], roster: '' };
    var pAi = String((prose && prose.ai) || '');
    var pUser = String((prose && prose.user) || '');
    /* 关键词扫描要拿「正文文本」，不是正文对象 —— 传对象进去会 join 成 "[object Object]"，
       命中的永远是零个人，人物速查就再也送不出去了。 */
    var npcs = scanNpcs([pAi, pUser, extraHistory || ''], sd);
    S.lastNpcs = npcs.map(function (x) { return x.name; });

    var sys = [];
    sys.push('你是《天元一界》修仙卡的状态变量补算器。主模型这一楼漏写或写坏了 <UpdateVariable>，你负责把它补出来。');
    sys.push('你不写小说、不写剧情、不解释、不寒暄。你只输出一个 <UpdateVariable> 块。');
    sys.push('');
    sys.push('════ 变量更新规则（最高优先，逐条照办） ════');
    sys.push(wb.rules || '（未读到《变量更新规则》世界书条目：按 add/replace/remove 规范，只更新本楼真变了的字段；战斗状态只在正文出现完整 <战斗开始> 时置 true，严禁写 false。）');
    sys.push('');
    sys.push('════ 变量输出格式（结构照抄） ════');
    if (wb.format && wb.format.length) {
      wb.format.forEach(function (f) { sys.push(f.content); sys.push(''); });
    } else if (wb.fmtInRules) {
      /* ★ v431：格式已经在上面那段《变量更新规则》里了（它有完整的 <UpdateVariable> 结构）。
         这里**不再重复贴一遍**（同一份内容贴两次，模型容易把第二份当成"另一个格式"），
         只补一句确认，并给出四个操作的**各一例** —— 原来那个兜底示例只有 replace，
         模型照着写就会永远只用 replace（delta 加成赋值的老病就是这么来的）。 */
      sys.push('（完整结构见上方的《变量更新规则》末尾「变量输出格式」，逐字照它的形状输出。）');
      sys.push('四种操作各一例：');
      sys.push('[ {"op":"replace","path":"/时间/精确时间","value":"08:30"},');
      sys.push('  {"op":"delta","path":"/主角信息/气血","value":-15},');
      sys.push('  {"op":"insert","path":"/人物列表/柳三娘","value":{"姓名":"柳三娘","性别":"女","势力":"散修","种族":"人族","好感度":50,"在场状态":true}},');
      sys.push('  {"op":"remove","path":"/背包/一品回春丹"} ]');
      /* ★ v432：这里原来举的例子是 `{"op":"insert","path":"/全局/九州热议/-"}` ——
         而热议已改成「整组替换」，往数组末尾追加是**错的写法**（旧的议论会留着）。
         ⇒ 示例改成往 人物列表 插一个人（那是真·追加语义），
           热议/闲杂的写法交给上面的细则，别再在这里给一个会把人带歪的例子。 */
      /* ★ v475：示例里补上 `"性别"`。用户 2026-10-30 新加这条变量，
         而**模型只照着示例的字段写** —— 示例里没有的键它永远不产。
         （这正是"世界书是 prompt、留示例就等于没下架"那条铁律的正面用法。） */
    } else {
      sys.push('<UpdateVariable>\n<Analysis>\n（本楼数值推演）\n</Analysis>\n<JSONPatch>\n[ {"op":"replace","path":"/时间/精确时间","value":"08:30"}, {"op":"delta","path":"/主角信息/气血","value":-15} ]\n</JSONPatch>\n</UpdateVariable>');
    }
    sys.push('');
    sys.push('════ 路径白名单（只能写这些顶层，别的一律不许碰） ════');
    sys.push('/全局/*、/时间/*、/地理/*');   /* ★ v1.052：/战斗状态 已删 */
    sys.push('/主角信息/*（含 四维、已学本领.玄技/玄诀、装备武器、血脉、天骄、灵宠）');
    sys.push('/人物列表/{姓名}/*（含 好感度(0~100)、心里话、在场状态、境界、气血/灵力、已学本领、装备武器、势力、天骄、灵宠、血脉）');
    sys.push('/背包/{物品名}/*（物品数量减到 0 必须用 remove 整条删掉，不许 replace 成 0）');
    /* ★★★ v432：热议 / 闲杂事件 —— 这两栏是**整组替换**，不是往上堆。
       用户 2026-10-28：「九州热议改成每3或4轮更新一次…一次三个评论，只对目前的事件议论；
       新弄一个闲杂事件…大概每4轮生成一次」。节奏用**游戏内日期差**判（/全局/*更新日 对比 /时间/日期）。
       ⚠ 这两条必须写进提示词，不能只靠细则：08 是"补算器"，它最容易犯的错就是
         "看到议论少就往里补一条"，而正确动作是**整组 replace 成新的 3 条**。 */
    sys.push('/全局/九州热议（**整组**，恒 3 条，`宗门｜昵称｜内容`）：只在 /全局/热议更新日 为空或与 /时间/日期 相差 ≥3 天时整组换新，并把 /全局/热议更新日 写成今天的日期；没到点就一个字都不改。只议论当下真发生的事。');
    sys.push('/全局/闲杂事件（**整组**，恒 3 条，`地点｜一句话`）：市井小事与趣事，不许写危机、宗门大事、主角相关；只在 /全局/闲杂更新日 为空或与 /时间/日期 相差 ≥4 天时整组换新，并同步改写 /全局/闲杂更新日。');
    /* ★ v292：任务与功勋 —— **全局系统，不是宗门专属**。
       用户原话：「任务千万不要围绕宗门任务去做，而是一个全局的系统，适应所有场所」。
       所以白名单里不写「功德堂/悬赏榜」这类出处词，只给三条通用规矩：
         · 了结必须整条 remove，不许留空壳
         · 功勋只在「交差结付」与「兑换/打点」两处增减，打怪采药不直接给
         · 同一件事按「来源」决定酬劳形态：宗门给名分、世家给人情、官府给路引、市井给现钱 */
    sys.push('/任务 下的全部字段：进行中.{任务名}.阶|来源|委托人|地点|目标|期限|酬劳、已完成');
    sys.push('任务**不限于宗门**：来源可写 宗门/世家/官府/市井/私托/自定 六种；街边私活、世家托付、官府缉令、自己定的目标都算任务，一律记进 /任务/进行中。');
    /* ★ v296（用户 2026-10-21）：「任务的进度去掉，只以最终目标为完成指标，目标完成就是完成，
       没有进度这一说，我们要简单化，轻量化，让 ai 减少负担」。
       ⇒ 没有「进度」字段。别再让模型估百分比 —— 估了也没人核，还多一道要写错的字段。 */
    sys.push('任务**没有「进度」字段**：差事只有「在办」与「了结」两态，判据就是「目标」那一句有没有做到。做到了就整条 remove 并追加到 /任务/已完成；没做到就原样留着，别自己估一个百分比。');
    /* ★ 任务名就是 JSONPatch 的路径段：含斜杠会把路径断开（/任务/进行中/护送/商队/目标 = 5 级），
       字段会写进一个谁都不读的位置，界面永远是空的，且**不报错**。这条必须写进白名单。 */
    sys.push('任务名**不得含斜杠 / 、波浪号 ~ 、井号 #**（它们是 JSONPatch 的路径分隔符与转义符，含了会把字段写错地方且不报错），≤12 字；任务名就是 /任务/进行中 下的键，同一个任务不许开两条。');
    sys.push('任务了结（交差或判定失败）必须把 /任务/进行中/{任务名} 整条 remove，并在 /任务/已完成 追加「任务名（阶·来源）」；不许 replace 成空对象留在表里。进行中满 10 条时不许硬接第 11 条（超出会静默丢最早那条）。');
    /* ★ 功勋的记账口径：它不是独立变量，而是背包里的一条材料，按出处命名 */
    sys.push('功勋写进 /背包，**不写 /任务/功勋（这个字段不存在，故意的）**：给谁的活就记成「谁家的功勋」，如「太一门功勋」「轩辕氏功勋」「玄冰卫城功勋」；类型=材料、品质=无、描述写清是哪一处给的活（如「太一门功德堂账」），数量累加。太一门的功勋在轩辕氏那里不认，反之亦然 —— 别把不同出处的功勋合并成一条。');
    sys.push('功勋只在「交差结付」时增加、「兑换／打点关系」时减少；打怪、采药、赶路不直接给功勋（那是玄石与材料的事）。');
    /* ★ v296（用户 2026-10-21）：「大位置只能写州+地区，如中州·xxx·城市/势力，小位置写具体的
       如这个城市的哪个地方。不然以后地图怎么显示你在哪」。
       域号是封闭表（见世界书《三州地理总纲》），现编就对不上舆图坐标 —— 这条必须在提示词里钉死。 */
    sys.push('地理只走 /地理/大位置 与 /地理/小位置，严禁写 /主角信息/地点、/地点、/玩家位置。');
    sys.push('**大位置固定三段**：`州·域·城/势力`（中文间隔号「·」）。**州只有三个：人州／妖州／魔州**，别的州名一个都不许写；域取《三州地理总纲》的域号表（**封闭表，不许现编**），人州只有 中域／雪域／沙洲；第三段写落脚的城、宗门或世家。例：`人州·中域·太一门`、`人州·雪域·玄冰卫城`、`人州·沙洲·月牙泉城`。**不许只写州名**；出了据点就写 `通路`／`墙外` 当第三段 —— 舆图要靠这三段定位玩家在哪。');
    sys.push('**小位置**只写大位置那一处**里面的具体地方**：山门／主峰云海／外门演武场／丹房／后山禁地／坊市东街／客栈二楼。一句话，不重复州名。');
    /* v71：战斗脚本已关，战斗不再写任何熟练度类字段 ——
       改由模型/本补全脚本自己按《变量更新规则》二 累加写入。武器只有「装备武器」一件，
       玄技/玄诀写好即入「已学本领」，再无「装备玄技/装备玄诀」这类字段。 */
    sys.push('玄技/玄诀写进 /主角信息/已学本领 对应的那一类；兵器写进 /主角信息/装备武器（只此一件）。');
    /* ★★★ v296（用户 2026-10-21）：「npc 每次遇到都得翻译，这会让玩家厌烦，所以，自然生成的玄技，
       必须有个规范的格式，能够直接不用翻译就给脚本读…总之看怎么样能最稳定怎么来」。
       ⇒ 效果的值改成「机制串｜描写」：机制串在前，脚本一行正则就能读，
         再不用等外置翻译；`｜` 之后是给人看的画面，脚本不读。
         为什么机制必须在最前：_v75ParseEffect 的规范语法是「行首 1~4 个汉字 + 冒号」，
         把描写放前面就会掉进自然语言兜底（靠猜），把描写放后面则完全不影响解析。 */
    /* ★★★ v449：这份「机制名清单」是本项目**唯一**一处会把下架名复活的源头 ★★★
       用户的整个用法就是：AI 照这份清单写新招式。清单里留着 `定身`，AI 就会一直写
       `{ 定身: "1" }` —— 而它已经从引擎下架，写出来落 narrative、打起来毫无作用。
       表现是「AI 写得很像那么回事，实际一点用没有」，比直接报错难查十倍。
       ⚠ 上一轮漏改的就是这里：我清了 17 份人设的现存数据（22 处），却漏了这份**未来数据的模板**。
         现存数据清一次就完事，模板没清则每生成一个新的就多一条死效果 ——
         所以这类"清单/枚举"必须和机制名表**同一轮**改，不能留到下一轮补。
       ⚠ 反过来也别在这里加引擎没有的名字：这份清单是**硬约束**（下面写着"只能取"），
         多写一个不存在的名字，等于骗 AI 去写死效果。要加减必须与 XZ_ATOM_TYPES 同步。 */
    sys.push('**玄技/玄诀的「效果」是效果集：键＝机制名，值＝「数值[:手数]｜描写」**（`{ 灼烧: "8:3｜衣角沾上一星不灭的火" }`，第二个数字是手数），中文竖线 `｜` 之后写画面与手感。键里的机制名就是引擎读的那个机制，脚本**不做翻译**；`｜` 后面那半句人看，脚本不读，写多写少都不影响结算。兵器与血脉的 `效果` 是一整串字符串（没有键），照旧写完整的 `机制:数值｜描写`（`增伤:10，暴击:15｜银白古剑…`）。');
    sys.push('**一个效果键只放一条机制，机制名只写在键上、值里不许再写一遍**（多一条效果就多开一个键；同一招要两条同机制就写 `伤害`、`伤害2`）。机制名只能取《效果表》那张表：伤害／治疗／护盾／吸血／持续伤害／灼烧／中毒／流血／腐蚀／增伤／减伤／闪避／提速／暴击／暴伤／穿防／回血／回蓝／气血上限／灵力上限／免死／破盾／抗暴／虚弱／易伤／减速。');
    sys.push('**值是「数字[:手数]｜描写」，机制名只在键上**：`{ 伤害: "2400｜火焰席卷前方，热浪迫人", 灼烧: "8:3｜衣角沾上一星不灭的火" }` —— 键已经写了机制名，值里就不要再写一遍（写成 `{ 增伤: "增伤:20:3｜…" }` 是把数值位占了，加成会变成 0）。同一招要两条同机制就写 `伤害`、`伤害2`。');
    sys.push('**升级只改数字**：招式变强就在**区间内**把 `效果` 里的绝对值改大（一次最多 ×1.25），持续与百分比不变，其余字段原样不动。');
    /* ★ v297（用户 2026-10-21）：「升级技能的我们要弄个伤害区间…伤害最高多少，回血类最高多少，
       增益类最高多少，减益类最高多少」。
       没有上限的「往上改」等于把平衡交给 AI 的良心 —— 这里必须把上界写死。 */
    sys.push('**每一招都有上限，超了不许再涨**（表在《数值表》「升级区间」）：按「**施术者当前大境界**那一行 × **这一招的品质**那一列」查，查到一个数 —— 伤害、回血、护盾**都不得超过它**。到顶就封顶，再讲奇遇也不许超。');
    sys.push('**百分比练不上去**：增益/减益的百分比只按品质给（凡5%/黄8%/玄12%/地18%/天25%/神35%），且不超《数值表》的「效果封顶」。想把「减伤 15%」练成 20% —— 不行，那是换更高品质功法的事。');
    sys.push('**血脉只有四个字段**（名称／品阶／纯度／效果）：没有「说明」，来历与觉醒光景写进 `效果` 里 `｜` 之后那半句。**天骄只由血脉品阶决定**（见《天骄体系》），没有「天骄来历」，也没有后天靠装备堆出来这条路。');
    sys.push('只写《变量更新规则》「路径速查」里列出的路径；那里没列出的字段（如 灵宠成长值）一律不写。');
    /* ★ v77：删掉提示里的「伤势状态」—— 该字段已整体废除（用户定：气血已经表达了一切）。
       战后的气血/灵力照常按《变量更新规则》写进 /主角信息/气血 与 /灵力。 */
    sys.push('');
    if (!S.settings.wantAnalysis) sys.push('（本轮不要 <Analysis>，只给 <JSONPatch>。）');
    sys.push('第一个字符必须是 <，直接开始写 <UpdateVariable>。');

    var user = [];
    user.push(snapshotText(sd));
    user.push('');
    user.push('【本轮相关人物速查（由关键词触发，只送命中的人；没提到的角色不要写）】');
    if (npcs.length) {
      npcs.forEach(function (n) { user.push('- ' + n.line + '　〔' + n.why + '〕'); });
    } else {
      user.push('- （本轮没有命中已知角色。正文若出现新人，按正文归纳身份，用 add 建 /人物列表/{名} 记录。）');
    }
    user.push('');
    if (extraHistory) {
      user.push('【前几轮上下文（供判断关系与时间跨度，别复述）】');
      user.push(extraHistory);
      user.push('');
    }
    user.push('【本楼玩家行动】');
    user.push(pUser ? pUser.slice(0, 1500) : '（无）');
    user.push('');
    user.push('【本楼正文】');
    user.push(pAi.slice(0, mode === 'deep' ? 6000 : 4000));
    user.push('');
    user.push('按规则与格式，给出这一楼应当写入的 <UpdateVariable> 块。没变的字段不要出现；全都没变就只给 <JSONPatch>[]。');

    return { system: sys.join('\n'), user: user.join('\n'), npcs: npcs };
  }

  /* ══════════════════ 九、调用：主模型中继 / 自填接口 ══════════════════ */
  /* ★ v337：把玩家填的地址归一成「base」（不含 /chat/completions）。
     原来直接 `base + '/chat/completions'`，玩家粘完整地址就会拼成
     `.../chat/completions/chat/completions`，报 404 而他完全看不出为什么。 */
  function baseOf(u) {
    var b = String(u || '').trim().replace(/\/+$/, '');
    b = b.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
    b = b.replace(/\/messages$/i, '');          /* Anthropic 协议的尾巴，粘进来也认 */
    /* 有人会把 /models 也粘进来 */
    b = b.replace(/\/models$/i, '');
    b = b.replace(/\/+$/, '');
    /* ★★★ v414：火山 Coding Plan 有**两个**官方 Base URL，同一份 Key：
         · https://ark.cn-beijing.volces.com/api/coding       （Anthropic 协议 /messages）
         · https://ark.cn-beijing.volces.com/api/coding/v3    （OpenAI 协议 /chat/completions）
       本脚本只会说 OpenAI 协议，所以玩家粘了前者（或从 Claude Code 那边抄来的）
       必须补成后者 —— 否则拼出来是 `/api/coding/chat/completions`，必然 404，
       而报错只会说"HTTP 404"，看着像地址写错。 */
    if (/^https?:\/\/ark\.cn-beijing\.volces\.com\/api\/coding$/i.test(b)) b += '/v3';
    return b.replace(/\/+$/, '');
  }

  function apiConfig() {
    var set = S.settings || loadSettings();
    if (set.apiMode === 'custom') {
      var _ep = baseOf(set.base) + '/chat/completions';
      var _mdl = String(set.model || '').trim();
      /* ★★★ v389：地址填了豆包、模型名却还是默认的 `gpt-4o-mini` ⇒ 必然 404 ★★★
         这条是「填不了」的第四种形状，也是最容易被忽略的一种：
         玩家把地址和 Key 都填对了、也点了测试，结果报 404 说他 Key/地址不对，
         其实只是**模型名没换**（默认值是 OpenAI 的 gpt-4o-mini）。
         只做一件事：认得出是豆包、且模型名仍是 OpenAI 那套默认值时，
         自动换成兜底表第一个（官方主推 2.1 pro）。**玩家自己填过的不动。**
         ⚠ 判断「没填过」用 DEFAULTS.model 比对，不许写死 'gpt-4o-mini' 字面量
           —— 默认值以后一改，这里就悄悄失效了。 */
      var _noCorsMod = knownNoCors(_ep);
      /* ★★★ v414：Coding Plan 地址下，**在线推理的 Model ID 一定用不了**。
         官方文档点名禁的写法就是 `doubao-seed-2-0-pro-260215` 这一类（结尾带 6 位日期），
         而我们的兜底名单以前给的全是这种 ⇒ 选完就是 model not found。
         ⇒ 两种情形一律换成该服务商名单的第一个：
             · 模型名空着 / 还是默认的 gpt-4o-mini
             · 模型名长得像在线推理 ID（`-26xxxx` 结尾）而地址是 /api/coding
         玩家自己填的**正常**名字（`doubao-seed-code`、`deepseek-v3.2`）一个字不动。 */
      /* ★ v418：识别范围放宽。用户实测填的是 `doubao-pro-32k-functioncall-preview`
         —— 这是**在线推理的老 ID**，Coding Plan 一样不认，但它既不以日期结尾、
         也不在 coding 名单里，旧规则放过它 ⇒ 测试必然 404。
         现在把这几种形态都当成在线推理 ID：结尾 6 位日期 / `-32k` 这类上下文长度 /
         `functioncall` / `preview`。玩家自己填的正常 coding 名（doubao-seed-code、
         deepseek-v3.2、glm-4.7）都不含这些词，不会被误伤。 */
      if (/\/api\/coding(\/|$)/i.test(_ep)
        && (/-2\d{5}$/.test(_mdl) || /-\d+k\b/i.test(_mdl) || /functioncall/i.test(_mdl) || /preview/i.test(_mdl))) {
        _mdl = '';
      }
      if (_noCorsMod && (!_mdl || _mdl === DEFAULTS.model)) {
        var _fbm = FALLBACK_MODELS[_noCorsMod] || [];
        if (_fbm.length) _mdl = _fbm[0];
      }
      return {
        mode: 'custom',
        endpoint: _ep,
        base: baseOf(set.base),   /* ★ v417：后端通道要的是根地址，不是 /chat/completions */
        key: String(set.key || '').trim(),
        model: _mdl || DEFAULTS.model
      };
    }
    return { mode: 'main' };
  }

  function executeApiCall(messages, maxTokens) {
    var cfg = apiConfig();
    var temp = clamp((S.settings || {}).temperature, 0, 1);
    if (cfg.mode === 'custom' && (!cfg.key || !/^https?:/.test(cfg.endpoint))) {
      return Promise.reject(new Error('还没配置接口：请在「⚙ API 设置」里填地址与 Key，或把通道切回「酒馆主模型」'));
    }

    /* ★ 模式为 main 时：优先调用当前酒馆主模型的 generateRaw（完全对齐春日狂想曲的成熟架构） */
    if (cfg.mode === 'main') {
      return new Promise(function (resolve, reject) {
        var TH = null;
        var hWin = hostWindow();
        try { TH = (hWin && hWin.TavernHelper) || null; } catch (e0) {}
        if (!TH) { try { TH = (typeof window !== 'undefined' && window.TavernHelper) || null; } catch (e1) {} }
        if (!TH) {
          try {
            var ifrs = Array.from((hWin?.document || document).querySelectorAll('iframe'));
            for (var fi = 0; fi < ifrs.length; fi++) {
              if (ifrs[fi].contentWindow && ifrs[fi].contentWindow.TavernHelper) {
                TH = ifrs[fi].contentWindow.TavernHelper;
                break;
              }
            }
          } catch (e2) {}
        }

        var promptText = '';
        if (Array.isArray(messages)) {
          promptText = messages.map(function (m) {
            return (m.role === 'system' ? '【规则与格式要求】\n' + m.content : m.content);
          }).join('\n\n');
        } else {
          promptText = String(messages || '');
        }

        if (TH && typeof TH.generateRaw === 'function') {
          function tryOne(fn) {
            return Promise.resolve().then(fn).then(function (out) {
              var s = String((out && (out.content || out.text)) || out || '');
              if (s.trim()) return s;
              return null;
            }).catch(function () { return null; });
          }
          var shapes = [
            function () { return TH.generateRaw({ ordered_prompts: [{ role: 'user', content: promptText }] }); },
            function () { return TH.generateRaw({ user_input: promptText }); },
            function () { return TH.generateRaw({ ordered_prompts: [promptText] }); },
            function () { return TH.generateRaw(promptText); }
          ];
          var idx = 0;
          function next() {
            if (idx >= shapes.length) return null;
            var f = shapes[idx++];
            return tryOne(f).then(function (got) { return got || next(); });
          }
          next().then(function (txt) {
            txt = String(txt || '');
            if (!txt.trim()) {
              throw new Error('酒馆主模型没有返回内容，可在「⚙ API 通道」切到「另选专属」');
            }
            resolve(txt);
          }).catch(function (err) {
            reject(new Error('调用酒馆主模型失败：' + String((err && err.message) || err) + '（可在「⚙ API 通道」切到「另选专属」填入独立 API）'));
          });
          return;
        }

        // 兜底：如果拿不到 TavernHelper.generateRaw，尝试调用酒馆后端接口
        fetch('/api/backends/chat-completions/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: messages, max_tokens: maxTokens, temperature: temp })
        }).then(function (res) {
          return res.text().then(function (txt) {
            if (!res.ok) throw new Error('HTTP ' + res.status + '：' + txt.slice(0, 100));
            try {
              var j = JSON.parse(txt);
              var one = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || (j && j.content) || '';
              if (!one) throw new Error('返回无内容');
              resolve(String(one));
            } catch (eJ) { resolve(txt); }
          });
        }).catch(function (eF) {
          reject(new Error('未能通过酒馆主模型生成：' + eF.message + '。建议在「⚙ API 通道」切到「另选专属」独立配置。'));
        });
      });
    }

    var ctrl = null;
    try { ctrl = new AbortController(); } catch (eC) {}
    var timeout = clamp((S.settings || {}).timeoutMs, 8000, 180000);
    var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (eA) {} } }, timeout);

    var url = cfg.endpoint;
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key };
    /* ★★★ v389：豆包 2.1 系列**默认开着深度思考** ⇒ 不给 thinking 字段时，
       思维链会把 max_tokens 吃光，正文 `content` 可能是空串，正文全在
       `reasoning_content` 里 ⇒ 旧代码只读 content ⇒ 报「返回里没有正文内容」，
       玩家看到的就是「豆包配好了但补不出变量」。
       官方文档（2026-10-24 核对，ark.volcengine.com/docs/responses-api-deep-thinking）：
         doubao-seed-2-1-pro-260915 / -lite-260915 / -pro-260628 / -turbo-260628
         doubao-seed-2-0-lite-260428 / -mini-260428 / doubao-seed-evolving
       都支持 `thinking:{type:'disabled'}`。变量补全是**算账活，不需要深想**，
       关掉思考既省 token 又快，正好。只对认得出的服务商加这个字段 ——
       别家不认这个键，无脑塞进去可能被当成非法参数整单拒掉。 */
    var body = { model: cfg.model, messages: messages, max_tokens: maxTokens, temperature: temp };
    if (knownNoCors(url)) body.thinking = { type: 'disabled' };

    /* ★ v417：对没有 CORS 头的服务商（火山），这一发走酒馆后端；其余仍旧直连。 */
    return xzChatFetch(url, {
      method: 'POST', headers: headers, body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }, cfg, messages, maxTokens, temp).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (txt) {
        if (!res.ok) {
          /* ★ v414：Coding Plan 的 404 九成是**模型名用了在线推理那一套**，
             而不是 Key 或地址错。光报 HTTP 404 会把人引到错方向，这里直接说破。 */
          var _hint404 = '';
          if (res.status === 404 && /\/api\/coding/i.test(url)) {
            _hint404 = '｜这个地址是 Coding Plan：模型名要写 doubao-seed-code / doubao-seed-2.1-pro / '
              + 'deepseek-v3.2 这种，**不能**写 doubao-seed-2-1-pro-260915 这类在线推理 ID（带 6 位日期的那种）';
          } else if (res.status === 401 && /\/api\/coding/i.test(url)) {
            _hint404 = '｜Coding Plan 要单独的 API Key（在开通管理页建），线上推理的 Key 不一定通用';
          }
          throw new Error('HTTP ' + res.status + '：' + String(txt).slice(0, 160)
            + '（地址 ' + url + '）' + _hint404 + arkHint(txt));
        }
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { throw new Error('返回不是 JSON：' + String(txt).slice(0, 140)); }
        var _msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
        /* ★ v389：`content` 为空时退回 `reasoning_content`。
           为什么允许「拿思维链当正文」：总比整轮补算直接失败好。
           但要在提示里说清 —— 思维链里常带「草稿/让我想想」这类话，
           下游 parsePatch 已经用 withoutReasoning 剥过草稿块，能兜住。 */
        var one = _msg.content || (j && j.content) || '';
        if (!String(one).trim() && _msg.reasoning_content) one = _msg.reasoning_content;
        if (!one) throw new Error('返回里没有正文内容');
        return String(one);
      });
    }).catch(function (err) {
      clearTimeout(timer);
      var raw = String((err && err.message) || err);
      if (err && (err.name === 'AbortError' || /aborted/i.test(raw))) {
        throw new Error('请求超时（' + Math.round(timeout / 1000) + ' 秒没等到回应）：' + url);
      }
      throw new Error(raw);
    });
  }

  function modelsUrl() {
    /* ★ v337：玩家常把**完整对话地址**粘进来（`.../v1/chat/completions`），
       原写法会在后面再接一个 `/models` ⇒ `.../chat/completions/models`，必然 404。
       归一逻辑统一走 `baseOf()`，别再各自写一份。 */
    var b = baseOf((S.settings || {}).base);
    if (!b) return '';
    /* baseOf 已经剥过 /models 了，这里直接接一个；
       不要再写 `test(/\/models$/) ? b : b + '/models'` —— 那个三元永远走后半，
       留着只会让下一个人以为「已经带 /models 的情况」被处理过。 */
    return b + '/models';
  }

  /* ★ v337：有些服务商的 `/models` **不发 CORS 头**，浏览器在预检阶段就拦掉，
     根本到不了服务端 —— 于是填再对的地址与 Key 都只会看到 `Failed to fetch`。
     实测（2026-10-22，带 Origin 请求）：
        DeepSeek / 阿里百炼 / 智谱 / Moonshot 的 /models 都带 access-control-allow-origin
        火山方舟（豆包）的 /models **一个 CORS 头都没有**，而它自家的 /chat/completions 却齐全
     这不是我们代码的问题，也不该让玩家以为是自己填错了 ⇒ 单独认出来，说人话。 */
  var NO_CORS_PROVIDERS = [
    /* ★★★ v414（用户 2026-10-27）：「还是不行，填不了
       https://ark.cn-beijing.volces.com/api/coding/v3 这个」
       ── 这条是**独立的服务**，不只是「同一个火山的另一个路径」：
          · `/api/v3`          = 在线推理（按 token 计费）
          · `/api/coding/v3`   = Coding Plan（按次数的订阅套餐）
          两者的**模型名是两套，互不通用**。官方文档原话（2026-10 核对：
          https://console.volcengine.com/ark/.../coding-plan-personal-plan-overview）：
            「请勿填写成在线推理的 Model ID，例如 doubao-seed-2-0-pro-260215」
          而我们原来只认出一个「火山方舟（豆包）」，兜底名单里全是
          `doubao-seed-2-1-pro-260915` 这种**在线推理 ID** ⇒ 玩家在 coding 地址下
          选了它，必然 404（而且 404 的措辞是 model not found，看着像 Key 不对）。
          ⇒ 先把 coding 单独认出来，给它自己那张名单。
       ⚠ 顺序即优先级：coding 必须排在通用火山规则之前（正则都会命中同一域名）。 */
    { re: /ark\.cn-beijing\.volces\.com\/api\/coding/i, name: '火山方舟 Coding Plan' },
    { re: /volces\.com|volcengine|ark\.cn-beijing/i, name: '火山方舟（豆包）' }
  ];
  function knownNoCors(url) {
    for (var i = 0; i < NO_CORS_PROVIDERS.length; i++) {
      if (NO_CORS_PROVIDERS[i].re.test(String(url))) return NO_CORS_PROVIDERS[i].name;
    }
    return '';
  }
  /* 已知 CORS 不通的服务商兜底模型名：拉不到列表时**至少给一串能直接用的**，
     免得玩家对着空白框猜。

     ⚠ 这张表必须照着官方模型列表页抄，不能凭印象写：
       来源 https://www.volcengine.com/docs/82379/1553586 （火山方舟「模型列表」）
       核对日期 2026-10-22
     初版就是凭印象写的，塞了 4 个 doubao-seed-1-6-* 和 2 个 doubao-pro-32k，
     全都不在官方列表里；反而当前主推的 2.1 系列一个都没写。
     给玩家一串查不到的模型名，比给他一个空白框更糟 —— 他选中后只会得到一个看不懂的 404。 */
  var FALLBACK_MODELS = {
    '火山方舟（豆包）': [
      /* 官方「推荐模型」（2.1 代，当前主推） */
      'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-turbo-260628', 'doubao-seed-evolving',
      /* 往期仍在售 */
      'doubao-seed-2-1-pro-260628', 'doubao-seed-2-0-lite-260428',
      'doubao-seed-2-0-mini-260428',
      /* 官方标注「即将下线」：留着是因为还有人在用，排最后 */
      'doubao-seed-2-0-pro-260215'
    ],
    /* ★★★ v414：Coding Plan 专用名单。**与上面那张不能混** ——
       这些是「Model Name」（`doubao-seed-code`），不是「在线推理 Model ID」
       （`doubao-seed-2-0-code-preview-260215`）。填错就是 404。
       来源：官方《套餐概览 · 支持的模型》+ TRAE 接入指南的 Model Name 列，
       核对日期 2026-10-27。顺序＝推荐顺序（旗舰在前，`ark-code-latest` 放最后：
       它是"跟随控制台选择"，第一次就选它反而看不出到底跑了哪个模型）。 */
    '火山方舟 Coding Plan': [
      'doubao-seed-2.1-pro', 'doubao-seed-2.1-lite',
      'doubao-seed-code', 'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite',
      'deepseek-v3.2', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.5',
      'ark-code-latest'
    ]
  };

  /* ══════════════ 酒馆助手优先（v412）══════════════
     用户 2026-10-27：「看看人家的模型拉取，能不能填豆包，能的话，参考过来」。
     对方那段的关键**不是**请求写法，而是**先问谁**：

         let s;
         try {
           if (typeof getModelList !== 'undefined') s = getModelList;
           else if (window.getModelList) s = window.getModelList;
           else if (window.parent && window.parent.getModelList) s = window.parent.getModelList;
         } catch (e) {}
         if (s) { const e = await s({ apiurl, key }); if (e?.length) return e; }
         // 只有拿不到才自己 fetch(base + '/models')

     `getModelList` 跑在**酒馆助手的扩展上下文**里，不受网页 CORS 限制。
     而火山方舟（豆包）的 `/api/v3/models` 既不给 CORS 头、又常常直接 404
     ⇒ 我们裸 fetch 永远拿不到，只能塞一张手抄的备用名单（FALLBACK_MODELS 那段）。
     走这条路，豆包才真的能"拉出列表来选"。

     ⚠ 三条纪律：
       ① 拿不到**不许报错**，必须静默回落下面那条 HTTP 老路 ——
          玩家没开酒馆助手时，DeepSeek / 百炼 / 智谱 / Moonshot 这些带 CORS 的家照样能拉；
       ② `apiurl` 要传**根地址**（`baseOf` 归一过的），别把 `/models` 拼进去 ——
          助手侧自己会补；两边都补就变成 `/models/models`；
       ③ 返回可能是字符串数组，也可能是 `{id}` 对象数组，两种都收。 */
  function findTH() {
    var TH = null;
    try { var hWin = hostWindow(); TH = (hWin && hWin.TavernHelper) || null; } catch (e0) {}
    if (!TH) { try { TH = (typeof window !== 'undefined' && window.TavernHelper) || null; } catch (e1) {} }
    if (!TH) { try { TH = (typeof TavernHelper !== 'undefined' && TavernHelper) ? TavernHelper : null; } catch (e2) {} }
    if (!TH) {
      try {
        var ifrs = Array.from((hostWindow() && hostWindow().document ? hostWindow().document : document).querySelectorAll('iframe'));
        for (var fi = 0; fi < ifrs.length; fi++) {
          if (ifrs[fi].contentWindow && ifrs[fi].contentWindow.TavernHelper) { TH = ifrs[fi].contentWindow.TavernHelper; break; }
        }
      } catch (e3) {}
    }
    return TH;
  }
  /* ★★★ v415：参考脚本找的是**全局 `getModelList`**（`typeof getModelList !== 'undefined'`），
     而我 v412 只找了 `TavernHelper.getModelList` —— 名字一样、挂在两个地方。
     在酒馆助手的 iframe 里，`getModelList` 经常是**注入到 window 上的独立函数**，
     `TavernHelper` 上反而没有（或版本不同没导出）⇒ 我那条判断永远为 false
     ⇒ 静默回落到浏览器直连 ⇒ 被 CORS 拦 ⇒ 玩家看到"还是拉不了"。
     ⇒ 这里按参考脚本的顺序全找一遍：当前 window → 父窗口 → 各 iframe → TavernHelper。
     **顺序有意为之**：先把「宿主侧函数」找全，最后才用 TH 对象上的方法。 */
  function findModelListFn() {
    var cands = [];
    try { cands.push(window); } catch (e0) {}
    try { var hw = hostWindow(); if (hw) cands.push(hw); } catch (e1) {}
    try { if (window.parent && window.parent !== window) cands.push(window.parent); } catch (e2) {}
    try { if (window.top && window.top !== window) cands.push(window.top); } catch (e3) {}
    /* 各 iframe 的 window（酒馆助手把函数注入在主窗口或某个 iframe 里） */
    try {
      var d = (function () { try { return hostWindow().document; } catch (e) { return document; } })();
      var ifrs = Array.from(d.querySelectorAll('iframe'));
      for (var i = 0; i < ifrs.length; i++) {
        try { if (ifrs[i].contentWindow) cands.push(ifrs[i].contentWindow); } catch (ei) {}
      }
    } catch (e4) {}
    for (var k = 0; k < cands.length; k++) {
      var w = cands[k];
      try {
        if (!w) continue;
        /* ⚠ 必须判 typeof === 'function'：`typeof getModelList !== 'undefined'` 会命中
           一个同名但非函数的属性，调用时抛错，又被 catch 吞掉 ⇒ 看起来"没这个能力"。 */
        if (typeof w.getModelList === 'function') return { fn: w.getModelList, self: w };
      } catch (e5) {}
    }
    var TH = findTH();
    try {
      if (TH && typeof TH.getModelList === 'function') return { fn: TH.getModelList, self: TH };
    } catch (e6) {}
    return null;
  }

  /* ══════════════ 助手侧模型列表（v416）══════════════
     用户 2026-10-27：「把模型拉取部分整段搬过来，别自己改。」

     这段的形状就是「先问宿主函数的 getModelList，拿不到再自己 fetch」：

         const ne = async (apiurl, key) => {
           if (!apiurl) throw new Error('请先填写API地址')
           const arg = { apiurl }; if (key) arg.key = key
           let fn
           try {
             if (typeof getModelList !== 'undefined') fn = getModelList
             else if (window.getModelList) fn = window.getModelList
             else if (window.parent && window.parent.getModelList) fn = window.parent.getModelList
           } catch (e) {}
           if (fn) try {
             const r = await fn(arg)
             if (Array.isArray(r) && r.length) return r
           } catch (t) { console.warn(...) }
           let url = apiurl.trim(); if (!url.endsWith('/')) url += '/'
           if (!url.endsWith('models/') && !url.endsWith('models')) url += 'models'
           const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
           ...
         }

     ★ 与我们的差别（都已照搬）：
       ① 它把 `getModelList` 当**裸变量**先查一遍（`typeof getModelList !== 'undefined'`），
          再查 `window`、再查 `window.parent` —— 我原来只查 `TavernHelper`，位置就错在这里。
       ② 它拼 URL 是「补斜杠 + models」；我们原来是 `base + '/models'`（等价，但照抄更稳）。
       ③ 它失败时**把真实错误抛出来**（含尝试过的 URL），我们原来静默吞掉 ⇒ 玩家只知道"不行"。
     ⚠ 保留了我们的兜底：这段拿不到就继续走后端通道 / 兜底名单，不会让面板空着。 */
  function modelsViaRefHelper(base, key) {
    return new Promise(function (resolve) {
      if (!base) { resolve(null); return; }
      var arg = { apiurl: base };
      if (key) arg.key = key;

      /* ★★★ v526：原来这里自己找一遍 `getModelList`（裸标识符 + window + parent 三级），
         而本文件 1157 行早就有 `findModelListFn()` —— 那是 v415 专门写的，
         找得更全（当前 window / 宿主窗口 / parent / top / 所有 iframe / TavernHelper），
         而且判的是 `typeof fn === 'function'`（能挡掉"同名但非函数"的属性）。
         两套实现并存的问题不是"多写了"，是**行为不一致**：
         这里只找三级，宿主把函数注入在某个 iframe 上时，这条就走不到 ⇒ 静默回落 HTTP ⇒ CORS 拦。
         顺带一提，裸标识符 `getModelList` 在 ESLint 里是 undef（靠 typeof 守卫兜着，
         但守卫只保证"不会炸"，不保证"找得到"）。
         ⇒ 统一走 findModelListFn()，删掉本地那三段。**同一件事只留一个实现。** */
      var _hit = findModelListFn();
      var fn = _hit ? _hit.fn : null;
      var fnSelf = _hit ? _hit.self : null;
      if (!fn) { resolve(null); return; }

      var out = null;
      try { out = fn.call(fnSelf, arg); }
      catch (e3) { console.warn('[xz 拉模型] 全局 getModelList 调用失败：', e3); resolve(null); return; }
      Promise.resolve(out).then(function (r) {
        if (r && Array.isArray(r) && r.length) {
          console.log('[xz 拉模型] 走全局 getModelList，共 ' + r.length + ' 个');
          var arr = [];
          for (var i2 = 0; i2 < r.length; i2++) {
            var v = r[i2];
            var nm = String((typeof v === 'string') ? v : ((v && (v.id || v.name || v.model)) || '')).trim();
            if (nm && arr.indexOf(nm) < 0) arr.push(nm);
          }
          arr.sort();
          resolve(arr.length ? arr : null);
          return;
        }
        console.warn('[xz 拉模型] getModelList 返回的不是非空数组：', r);
        resolve(null);
      }, function (e) {
        console.warn('[xz 拉模型] getModelList 抛错：', e);
        resolve(null);
      });
    });
  }

  /* 参考包的 HTTP 兜底：URL 拼法、成功/失败判定与它逐行一致（补斜杠 → 补 models） */
  function modelsViaRefHttp(base, key) {
    if (!base) return Promise.resolve(null);
    var url = String(base).trim();
    if (url.charAt(url.length - 1) !== '/') url += '/';
    if (!/models\/?$/i.test(url)) url += 'models';
    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    console.log('[xz 拉模型] fetch →', url);
    return fetch(url, { method: 'GET', headers: headers }).then(function (res) {
      if (!res.ok) {
        console.warn('[xz 拉模型] HTTP ' + res.status + ' ' + (res.statusText || '') + '（' + url + '）');
        return null;
      }
      return res.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (eJ) { return null; }
        var arr = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : null);
        if (!arr) return null;
        var out = [];
        for (var i2 = 0; i2 < arr.length; i2++) {
          var v = arr[i2];
          var nm = String((typeof v === 'string') ? v : ((v && (v.id || v.name || v.model)) || '')).trim();
          if (nm && out.indexOf(nm) < 0) out.push(nm);
        }
        out.sort();
        return out.length ? out : null;
      });
    }).catch(function (e) {
      console.warn('[xz 拉模型] fetch 失败（多半是跨域）：', e && e.message, '｜URL:', url);
      return null;
    });
  }

  /* ══════════════ 最后一道：直接问酒馆后端（v415）══════════════
     这条路**完全不依赖酒馆助手**，也不受浏览器 CORS 限制：
       · 请求发到**同源的** `/api/backends/chat-completions/status`
       · 由 SillyTavern 的 Node 进程去连 Ark（服务端没有 CORS 这回事）
       · 正好是酒馆助手 `getModelList` 内部用的那个接口（源码 generate/index.ts:46）
     ⇒ 只要玩家在用酒馆（必然在用），这条就一定可用。
     实测（2026-10-27，本机 8000）：带 X-CSRF-Token 直接 POST 能通；
     不带 token 返回 403 Forbidden —— 所以 token 必须现取，不能硬编码。
     ⚠ 拿不到/报错一律 resolve(null)，静默交给浏览器直连那条老路（别的家还能用）。 */
  /* ★★★ v418：取请求头必须走 `SillyTavern.getRequestHeaders()`，别自己打 /csrf-token。
     宿主页面发同源接口时，标准做法就是 `fetch('/api/generate', { headers: SillyTavern.getRequestHeaders() })`
     —— 相对路径 + 官方头，**压根不需要知道 origin**。
     我们 v415/v417 自己 GET `/csrf-token` 再拼绝对地址，在卡所在的 iframe 里
     很可能拿不到会话 cookie（srcdoc/sandbox 的 origin 是 opaque）⇒ token 无效 ⇒ 403
     ⇒ 后端通道**静默失败** ⇒ 回落直连 ⇒ 玩家看到的还是 `Failed to fetch`。
     这就是"拉取能成、测试连接不行"反复出现的原因：两条路的头不是同一套。 */
  function stWindows() {
    var out = [];
    var push = function (w) { try { if (w && out.indexOf(w) < 0) out.push(w); } catch (e) {} };
    try { push(window); } catch (e0) {}
    try { if (window.parent) push(window.parent); } catch (e1) {}
    try { if (window.top) push(window.top); } catch (e2) {}
    try { push(hostWindow()); } catch (e3) {}
    try {
      var d = (function () { try { return hostWindow().document; } catch (e) { return document; } })();
      var ifrs = Array.from(d.querySelectorAll('iframe'));
      for (var i = 0; i < ifrs.length; i++) { try { push(ifrs[i].contentWindow); } catch (ei) {} }
    } catch (e4) {}
    return out;
  }
  function stOrigin() {
    var wins = stWindows();
    var hrefs = [];
    for (var i = 0; i < wins.length; i++) {
      try { if (wins[i].location && wins[i].location.href) hrefs.push(wins[i].location.href); } catch (e) {}
    }
    for (var k = 0; k < hrefs.length; k++) {
      try {
        var u = new URL('.', String(hrefs[k]));
        if (/^https?:$/i.test(u.protocol)) return u.href.replace(/\/+$/, '');
      } catch (e2) {}
    }
    for (var m = 0; m < hrefs.length; m++) {
      try {
        var o = new URL(String(hrefs[m])).origin;
        if (/^https?:\/\/[^/]+$/i.test(o)) return o;
      } catch (e3) {}
    }
    return '';
  }
  /* ★★★ v420：CSRF token **必须现取**，不能只信 getRequestHeaders()。
     实测（本机 8000，cookie 齐全）：
        cookie + Origin + Referer，**不带 X-CSRF-Token** → 403 Forbidden（HTML 页面）
        再加一个 X-CSRF-Token                        → 200
     `/status` 与 `/generate` 完全一样 ⇒ 403 的根因就是 token，不是地址/Key。
     而我们之前只在「找不到 SillyTavern 对象」时才去取 token —— 找到了但那份头里
     没有 token（或 token 已失效）时，就会拿一份**缺 token 的头**去发，必然 403。
     ⇒ 现在一律现取 `/csrf-token`，把 token **覆盖**进头里；拿不到才退回原头。 */
  function stHeaders() {
    var wins = stWindows();
    var base = null;
    for (var i = 0; i < wins.length; i++) {
      try {
        var st = wins[i].SillyTavern;
        if (st && typeof st.getRequestHeaders === 'function') {
          var h = st.getRequestHeaders();
          if (h && typeof h === 'object') { base = h; break; }
        }
      } catch (e) {}
    }
    return fetch('/csrf-token', { cache: 'no-store', credentials: 'include' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        var out = {};
        if (base) { for (var k in base) out[k] = base[k]; }
        out['Content-Type'] = 'application/json';
        if (j && j.token) out['X-CSRF-Token'] = j.token;
        if (!out['X-CSRF-Token']) console.warn('[xz] 没取到 CSRF token，酒馆大概率会 403');
        return out;
      })
      .catch(function () { return base || { 'Content-Type': 'application/json' }; });
  }
  /* 同源接口：先用相对路径（iframe 的 base 会解析到酒馆），403/404 再试绝对地址 */
  function stApi(path, opts) {
    /* 同源接口必须带 cookie（会话 + 用户名），否则一样 403 */
    var o = opts || {};
    if (o.credentials === undefined) o.credentials = 'include';
    return fetch(path, o).then(function (r) {
      if (r && (r.status === 403 || r.status === 404)) {
        var org = stOrigin();
        if (org) return fetch(org + path, o);
      }
      return r;
    }, function (e) {
      var org = stOrigin();
      if (org) return fetch(org + path, o);
      throw e;
    });
  }

  function modelsViaBackend(base, key) {
    if (!base) return Promise.resolve(null);
    return stHeaders()
      .then(function (headers) {
        return stApi('/api/backends/chat-completions/status', {
          method: 'POST',
          headers: headers,
          cache: 'no-store',
          body: JSON.stringify({
            reverse_proxy: base,          /* 原样传根地址，后端自己拼 /models */
            proxy_password: key || '',    /* 后端只认这个字段名，别写成 key */
            chat_completion_source: 'openai'
          })
        });
      })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || j.error) return null;
        /* 成功形状：{ data: [ {id}, … ] }；也见过 {data:{data:[…]}}，两种都收 */
        var arr = j.data;
        if (arr && !Array.isArray(arr) && Array.isArray(arr.data)) arr = arr.data;
        if (!Array.isArray(arr)) return null;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i] || {};
          var nm = String((typeof it === 'string') ? it : (it.id || it.name || it.model) || '').trim();
          if (nm && out.indexOf(nm) < 0) out.push(nm);
        }
        out.sort();
        return out.length ? out : null;
      })
      .catch(function () { return null; });
  }

  /* ══════════════ 对话也走酒馆后端（v417）══════════════
     用户 2026-10-27 截图：拉取模型成功了，但点「测试接口连通性」报
         ✘ Failed to fetch ｜ 实际用了模型 doubao-seed-2.1-pro、
           地址 https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions
     `Failed to fetch` 是**浏览器跨域**的固定措辞 —— 实测（带 Origin）：
        /api/coding/v3/chat/completions  → 401，**没有任何 access-control-allow-origin**
        /api/v3/chat/completions         → 同样没有
     ⇒ 拉取模型之所以能成，是走了酒馆后端；对话也必须走同一条路。
       浏览器直连这条路对火山永远不通，跟 Key、模型名都无关。

     做法：POST 同源 `/api/backends/chat-completions/generate`，
           body 用酒馆自己的字段（chat_completion_source / reverse_proxy / proxy_password），
           由 Node 进程去连 Ark。
     ⚠ 只对「认得出没有 CORS 的服务商」启用；别家继续直连，省一层中转。 */
  function callViaBackendChatRaw(cfg, messages, maxTokens, temp) {
    if (!cfg.base) return Promise.reject(new Error('没有可用的 Base URL'));
    return stHeaders()
      .then(function (headers) {
        return stApi('/api/backends/chat-completions/generate', {
          method: 'POST',
          headers: headers,
          cache: 'no-store',
          body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: cfg.base,
            proxy_password: cfg.key || '',
            model: cfg.model,
            messages: messages,
            max_tokens: maxTokens,
            temperature: temp,
            stream: false
          })
        });
      })
      .then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) throw new Error('酒馆后端 HTTP ' + r.status + '：' + String(txt).slice(0, 160));
          var j = null;
          try { j = JSON.parse(txt); } catch (e) { throw new Error('酒馆后端返回不是 JSON：' + String(txt).slice(0, 140)); }
          if (j && j.error) {
            var em = (j.error && (j.error.message || j.error.code)) || j.error;
            var rawErr = String(typeof em === 'string' ? em : JSON.stringify(em));
            throw new Error('酒馆后端报错：' + rawErr.slice(0, 180) + arkHint(rawErr));
          }
          var m = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
          var one = m.content || (j && j.content) || '';
          if (!String(one).trim() && m.reasoning_content) one = m.reasoning_content;
          if (!String(one).trim()) throw new Error('酒馆后端返回里没有正文内容');
          return String(one);
        });
      });
  }

  /* ══════════════ 走酒馆助手的 generateRaw（v419）══════════════
     用户 2026-10-27 截图：`酒馆后端失败：酒馆后端报错：Forbidden ｜ 浏览器直连也失败`
     —— Forbidden 是酒馆的 **CSRF/会话**拦的，不是火山拦的：
        拉模型能成（走的是助手的 getModelList，在助手上下文里带得动会话），
        而我们自己在卡的 iframe 里 fetch('/api/...') 拿不到有效会话 ⇒ 403。

     正解：**让助手替我们发**。JS-Slash-Runner 的 `generateRaw` 支持 `custom_api`：
         generateRaw({ user_input, custom_api: { apiurl, key, model, source:'openai',
                                                 max_tokens, temperature } })
     它跑在助手自己的上下文里，和 getModelList 是同一条通路 ⇒ 不会 403。
     （源码：src/function/generate/types.ts 的 CustomApiConfig） */
  function callViaHelperCustom(cfg, messages, maxTokens, temp) {
    return new Promise(function (resolve, reject) {
      var TH = findTH();
      var fn = (TH && typeof TH.generateRaw === 'function') ? TH.generateRaw : null;
      if (!fn) { reject(new Error('这个酒馆助手版本没有 generateRaw')); return; }
      var promptText = '';
      if (Array.isArray(messages)) {
        promptText = messages.map(function (m) {
          return (m.role === 'system' ? '【规则与格式要求】\n' + m.content : m.content);
        }).join('\n\n');
      } else {
        promptText = String(messages || '');
      }
      var api = {
        apiurl: cfg.base,
        key: cfg.key || '',
        model: cfg.model,
        source: 'openai',
        max_tokens: maxTokens,
        temperature: temp
      };
      var out = null;
      try { out = fn.call(TH, { user_input: promptText, custom_api: api }); }
      catch (e1) { reject(new Error('助手 generateRaw 调用失败：' + ((e1 && e1.message) || e1))); return; }
      Promise.resolve(out).then(function (r) {
        var txt = String((r && (r.content || r.text)) || r || '');
        if (!txt.trim()) { reject(new Error('助手 generateRaw 返回空')); return; }
        console.log('[xz 补算] 走酒馆助手 generateRaw（custom_api）');
        resolve(txt);
      }, function (e2) {
        reject(new Error('助手 generateRaw 报错：' + ((e2 && e2.message) || e2)));
      });
    });
  }

  /* ★ v421：把火山这几种错误翻成人话（实测于 2026-10-27，用真 Key）：
       InvalidSubscription → Coding Plan 没订阅/过期（不是 Key 错）
       ModelNotOpen        → 这个模型账号没开通
       SetLimitExceeded    → 该模型达到账号限额
     原文都很长且夹着 request id，直接抛出去玩家只会以为"Key 又错了"。 */
  function arkHint(txt) {
    var t = String(txt || '');
    if (/InvalidSubscription/i.test(t)) {
      return '｜这份 Key **没有有效的 Coding Plan 订阅**（或已过期）。两条路：'
        + '① 去方舟控制台续订 Coding Plan；'
        + '② 把地址换成 https://ark.cn-beijing.volces.com/api/v3 走在线推理（按 token 计费，实测可用）';
    }
    if (/ModelNotOpen/i.test(t)) {
      return '｜这个模型你的账号**没有开通**（方舟要求逐个开通，不是 Key 的问题）。'
        + '去 https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement 开通它；'
        + '或换一个已开通的（实测 doubao-seed-2-0-mini-260428 可用）';
    }
    if (/InvalidEndpointOrModel/i.test(t)) {
      return '｜这个模型名**不存在**（InvalidEndpointOrModel.NotFound）：确认拼写，'
        + '或在「拉取模型」列表里重新选一个';
    }
    if (/SetLimitExceeded/i.test(t)) {
      return '｜这个模型**达到账号限额**了（SetLimitExceeded），换模型或去控制台提额度';
    }
    return '';
  }

  /* 包成 fetch 的返回形状（下游代码只用到 ok / status / text()），
     这样执行层一个字都不用改；后端失败再**静默回落**直连（别家还能用）。 */
  function xzChatFetch(url, opts, cfg, messages, maxTokens, temp) {
    /* ★ v420：顺序改成**后端优先**。
       之前把助手 generateRaw 放第一，结果它返回 Forbidden（那个版本没带 CSRF），
       而后端那条又因为我们自己取的头缺 token 同样 403 —— 两条都堵着。
       现在 CSRF 现取现覆盖（见 stHeaders），后端这条路最可控 ⇒ 放第一位；
       助手那条留作后备（它不需要 CSRF 的版本会成功）；最后才是浏览器直连。 */
    if (!knownNoCors(url)) return fetch(url, opts);
    var wrap = function (txt) {
      return {
        ok: true, status: 200,
        text: function () {
          return Promise.resolve(JSON.stringify({ choices: [{ message: { content: txt } }] }));
        }
      };
    };
    return callViaBackendChatRaw(cfg, messages, maxTokens, temp).then(wrap, function (eB) {
      console.warn('[xz 补算] 酒馆后端失败，改走助手 generateRaw：', eB && eB.message);
      return callViaHelperCustom(cfg, messages, maxTokens, temp).then(wrap, function (eH) {
        console.warn('[xz 补算] 助手也失败，回落浏览器直连：', eH && eH.message);
        return fetch(url, opts).catch(function (e2) {
          throw new Error('酒馆后端：' + String((eB && eB.message) || eB)
            + '｜助手：' + String((eH && eH.message) || eH)
            + '｜浏览器直连：' + String((e2 && e2.message) || e2)
            + '（地址 ' + url + '）');
        });
      });
    });
  }

  function modelsViaTH(base, key) {
    return new Promise(function (resolve) {
      var hit = findModelListFn();
      var fn = hit && hit.fn;
      if (!fn) { resolve(null); return; }
      var self = hit.self;
      var out = null;
      try { out = fn.call(self, { apiurl: base, key: key }); }
      catch (e4) {
        /* 老版本助手的签名可能是 (apiurl, key)，再试一次；还不行就交回 HTTP 老路 */
        try { out = fn.call(self, base, key); } catch (e5) { resolve(null); return; }
      }
      Promise.resolve(out).then(function (list) {
        if (!Array.isArray(list)) { resolve(null); return; }
        var arr = [];
        for (var i = 0; i < list.length; i++) {
          var v = list[i];
          var nm = (typeof v === 'string') ? v : ((v && (v.id || v.name || v.model)) || '');
          nm = String(nm == null ? '' : nm).trim();
          if (nm && arr.indexOf(nm) < 0) arr.push(nm);
        }
        arr.sort();
        resolve(arr.length ? arr : null);
      }, function () { resolve(null); });
    });
  }

  function fetchModels() {
    if (!S.settings) loadSettings();
    var url = modelsUrl();
    var key = String(S.settings.key || '').trim();
    if (!url || !key) return Promise.reject(new Error('先填地址与 Key 再拉模型'));
    var noCors = knownNoCors(url);
    S.lastModelVia = '';
    var base = baseOf((S.settings || {}).base);
    /* 三级：① 酒馆助手的 getModelList（全局函数或 TH 方法）
             ② 酒馆后端 /api/backends/chat-completions/status（不依赖助手，最稳）
             ③ 浏览器直连 base + '/models'（带 CORS 的家仍然走这条）
       ★ v415：②是这次补的。原来只有 ①→③，而 ① 在多数环境里根本不存在
         ⇒ 直接掉到 ③ ⇒ 火山必然被 CORS 拦 ⇒ 玩家看到「还是拉取不了」。 */
    return modelsViaRefHelper(base, key).then(function (refList) {
      if (refList && refList.length) {
        S.models = refList.slice();
        S.lastModelVia = '助手 getModelList';
        saveModels(S.models);
        return S.models;
      }
      return modelsViaTH(base, key);
    }).then(function (thList) {
      if (thList && thList.length) {
        S.models = thList.slice();
        S.lastModelVia = '酒馆助手的 getModelList';
        saveModels(S.models);
        return S.models;
      }
      return modelsViaBackend(base, key);
    }).then(function (beList) {
      if (beList && beList.length) {
        S.models = beList.slice();
        S.lastModelVia = '酒馆后端（' + stOrigin() + '）';
        saveModels(S.models);
        return S.models;
      }
      return modelsViaRefHttp(base, key);
    }).then(function (httpList) {
      if (httpList && httpList.length) {
        S.models = httpList.slice();
        S.lastModelVia = '直连';
        saveModels(S.models);
        return S.models;
      }
      return modelsByHttp(url, key, noCors);
    });
  }

  /* 老路：自己打 `base + '/models'`。受浏览器 CORS 限制，火山方舟这类只能落到 FALLBACK_MODELS。 */
  function modelsByHttp(url, key, noCors) {
    return fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + key } })
      .then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) throw new Error('HTTP ' + res.status + '：' + String(txt).slice(0, 140));
          var j = null;
          try { j = JSON.parse(txt); } catch (e) { throw new Error('返回不是 JSON'); }
          var arr = (j && (j.data || j.models)) || [];
          var list = [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i] || {};
            var nm = it.id || it.name || it.model || '';
            if (nm && list.indexOf(String(nm)) < 0) list.push(String(nm));
          }
          list.sort();
          S.models = list; S.lastModelVia = '浏览器直连'; saveModels(list);
          if (!list.length) throw new Error('接口没给模型列表，手填模型名吧');
          return list;
        });
      })
      .catch(function (err) {
        var raw = String((err && err.message) || err);
        /* CORS 被拦时浏览器只给 "Failed to fetch" / "NetworkError"，
           完全指不到方向上 —— 认得出服务商就直说是跨域，并塞一串可用的模型名。 */
        var isCors = /Failed to fetch|NetworkError|Load failed|network error/i.test(raw);
        /* ★★★ v389：**404 也必须给兜底** ★★★
           实测（2026-10-24，curl 逐个探 OPTIONS 预检，带 Origin）：
             /api/v3/models              → 404，**无任何 CORS 头**
             /api/v3/model               → 404
             /api/v3/models/list         → 404
             /api/v3/foundation_models   → 404
             /api/v3/chat/completions    → 200 + access-control-allow-origin
           ⇒ 火山方舟**根本没有 `/models` 这个端点**，不是"有端点但不给跨域头"。
             这里有个必须说清的差别：我之前把它记成「不发 CORS 头」，那是不准确的 ——
             不发 CORS 头时浏览器抛的是 `Failed to fetch`（走 isCors 那条，兜底生效）；
             但端点不存在时，**某些环境（本地代理 / 插件注入 / 关了 CORS 检查的 webview）
             会真的把 404 响应递进来** ⇒ 走的是这一条，旧代码直接 `throw err`
             ⇒ 玩家看到的是「HTTP 404：」这种毫无信息量的字，下拉框还是空的
             ⇒ 这就是「豆包还是填不了」的直接形状（实测 A 跨域有兜底、B 404 无兜底）。
           ⇒ 对认得出的服务商，**不管走哪条失败路，都把它官方文档里的模型名摊出来**。
             玩家要的是"能选"，不是"知道为什么不能选"。 */
        var is404 = /HTTP\s*404/i.test(raw);
        if (!isCors && !(is404 && noCors)) throw err;
        if (noCors) {
          var fb = FALLBACK_MODELS[noCors] || [];
          if (fb.length) { S.models = fb.slice(); saveModels(fb); }
          var e2 = new Error(noCors + (isCors
              ? ' 的 /models 接口不返回跨域头，浏览器不允许网页直接读 —— '
              : ' 没有 /models 这个接口（返回 404），它的模型列表只能从官方文档看 —— ')
            + '不是你的地址或 Key 填错了，它家的对话接口是能用的。'
            + (fb.length ? '已换成官方文档里的 ' + fb.length + ' 个模型名供你直接选。' : '请手填模型名。'));
          e2.fallback = fb.slice();
          throw e2;
        }
        throw new Error('请求被浏览器拦住了（多半是跨域）：这个服务商的 /models 可能不返回跨域头。'
          + '可以直接手填模型名，对话接口通常照常可用。原始错误：' + raw);
      });
  }

  /* ══════════════════ 十、解析与写回 ══════════════════ */
  /* ★★★ v431：白名单漏了 `任务` —— 外置补全会把**每一条任务补丁全部丢掉** ★★★
     这不是"多收一个字段"，是整段功能失效，且**不报错**：
       ① 《变量更新规则》第 102 行把 `任务` 写成顶层；[InitVar]初始变量 第 32 行也有 `任务`；
       ② 08 自己的 buildPrompt 第 675 行还在明确教模型「一律记进 /任务/进行中」；
       ③ 而 sanitizeOps 只放行下面这 9 个顶层 ⇒ 模型给的 /任务/* 全部进 dropped，
          只在 toast 里留一句「剔掉 N 条非法」，玩家看不到，任务表永远是空的。
     ⇒ 判据只能是「[InitVar] 里有的顶层，这里必须都有」。（`任务` 就是唯一漏的那个。）
     ⚠ 加字段时照这个：**先看 [InitVar]初始变量.md 的顶层键**，别凭印象拼。
     曾经就是凭印象拼的 —— 拼的时候 `任务` 还没进初始变量，后来加上了没人回头补这里。 */
  var TOP_OK = ['战斗模式', '观战名单', '全局', '时间', '地理', '主角信息', '人物列表', '背包', '任务'];
  function unescSeg(s) { return String(s).replace(/~1/g, '/').replace(/~0/g, '~'); }

  function parsePatch(raw) {
    /* ★ v308：思维链里的草稿块不许当正文用 —— 否则取到的 Analysis/JSONPatch 是 think 里那份 */
    var txt = withoutReasoning(String(raw == null ? '' : raw)).replace(/```(?:json|xml|html)?/gi, '').replace(/```/g, '');
    var pm = txt.match(/<\s*(?:JSONPatch|json_?patch)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:JSONPatch|json_?patch)\s*>/i);
    var patchRaw = pm ? pm[1].trim() : '';
    if (!patchRaw) {
      var loose = txt.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (loose) patchRaw = loose[0];
      else if (/\[\s*\]/.test(txt)) patchRaw = '[]';
    }
    var arr = [];
    if (patchRaw) {
      try { arr = JSON.parse(patchRaw); } catch (e) { throw new Error('JSONPatch 解析失败：' + e.message); }
      if (!Array.isArray(arr)) arr = [];
    }
    var am = txt.match(/<\s*Analysis\b[^>]*>([\s\S]*?)<\s*\/\s*Analysis\s*>/i);
    return { analysis: am ? am[1].trim() : '', ops: arr };
  }

  /* 不合法的一律剔掉：顶层不在白名单、地点类、斗法台专属字段 */
  function sanitizeOps(ops) {
    var keep = [], dropped = [];
    (ops || []).forEach(function (op) {
      if (!op || !op.path || !op.op) { dropped.push('缺 op/path'); return; }
      var p = String(op.path).trim();
      if (p.charAt(0) !== '/') p = '/' + p;
      var top = unescSeg(p.split('/')[1] || '');
      if (TOP_OK.indexOf(top) < 0) { dropped.push(p + '（顶层 ' + top + ' 不在白名单）'); return; }
      if (/^\/(?:主角信息\/地点|地点|玩家位置)/.test(p)) { dropped.push(p + '（地点只能走 /地理）'); return; }
      /* ★ v10：不再读 /主角信息/大道/*。v86 起战斗脚本重开为版本二，
         ★ v1.052：/战斗状态 已删（标签即真相），这里不再有它的守卫。 */
      if (false) {
        /* removed */
        return;
      }
      if (false) { dropped.push('removed'); return; }
      /* ★ v429：delta / insert 必须原样保留 —— 旧写法把除 add/remove 之外的一切都归成
         replace，`{op:"delta", value:-15}` 会被写成「气血 = -15」，一刀打死人。
         move 仍归并成 replace（外置补全不做移动，落脚点就是目的地）。 */
      var opN = String(op.op || '').toLowerCase();
      var kept = (opN === 'remove') ? 'remove'
        : (opN === 'delta') ? 'delta'
          : (opN === 'insert' || opN === 'add') ? 'insert'
            : 'replace';
      if (kept === 'delta' && !isFinite(Number(op.value))) {
        dropped.push(p + '（delta 的增量不是数字，已按 0 处理会写坏原值，整条丢掉）');
        return;
      }
      /* ★★★ v431：`null` 一个都不许进变量树 ★★★
         《变量更新规则》第 131 行已经写死：「某个字段需要「空」的状态，也必须给一个具体的空值，
         绝不许写 null」。但那是**给模型看的话**，这里没有任何机械拦截 —— 模型写 null 就照写。
         后果不是"报错"，是更糟的静默错显：
           · MVU 把 null 存进变量树；界面上 `String(null)` 变成字面量 "null"，
             玩家看到「姓名：null」「境界：null」；
           · 数值字段变 null 后所有 `Number(x)` 得 0 或 NaN，伤害/血量算出 0 或 NaN；
           · 数组里塞一个 null，`for` 到它就抛，整页渲染走兜底错误块。
         ⇒ 按值兜底成「同类空值」：空串 / 空数组都在模型那一侧就该给，
           这里兜成**空串**（唯一不会让下游 Number/for 炸的选择）。
           ⚠ delta 的 null 上面已经被 isFinite 挡掉了，走不到这。 */
      if (kept !== 'remove' && op.value === null) {
        /* 数组末尾追加 null（如 `/人物列表/-` 这种）⇒ 整条丢掉：
           往清单里塞一个空串比塞 null 好不到哪去，玩家会看到一条空白热议。 */
        if (/(^|\/)-$/.test(p)) {
          dropped.push(p + '（往数组末尾追加 null，已丢弃）');
          return;
        }
        dropped.push(p + '（写了 null，已按空串落值；细则要求给具体的空值）');
        keep.push({ op: kept, path: p, value: '' });
        return;
      }
      keep.push({ op: kept, path: p, value: op.value });
    });
    return { keep: keep, dropped: dropped };
  }

  /* 把路径列表折成嵌套对象，供 MVU 深度合并。
     ★ remove 必须单独拎出来记成「删除清单」：
     把 remove 折进补丁对象里是没用的 —— 合并时「补丁里没有这个键」等于「什么都不做」，
     被删掉的东西原样留着（旧写法就有这个洞：物品消耗光了还挂在背包里）。
     ★★ v429：这里多收一类「增量」。
     世界书《变量更新规则》末尾的《变量输出格式》教模型用 `delta`（气血 -15 这种），
     而本函数原来是「不是 remove 就当成 replace 原样塞」——
     `{op:"delta", path:"/主角信息/气血", value:-15}` 会被写成 **气血 = -15**，
     一刀把人打死。增量不能进合并对象（合并对象里存的是**最终值**），
     必须先记下「路径 → 增量」，等深合并完再在现有值上加减。 */
  function opsToNested(ops) {
    var root = {};
    var removals = [];
    var deltas = [];
    var appends = [];
    (ops || []).forEach(function (op) {
      if (!op || !op.path) return;
      var segs = String(op.path).split('/').slice(1).map(unescSeg);
      if (!segs.length || !segs[0]) return;
      if (op.op === 'remove') { removals.push(segs); return; }
      if (op.op === 'delta') {
        var dv = Number(op.value);
        if (isFinite(dv)) deltas.push({ segs: segs, value: dv });
        return;
      }
      /* insert 与 replace 同路：合并对象里写最终值即可（记录型键、数组追加都走这里）。
         ⚠ 数组 `-` 追加是真追加，不能靠合并 —— 走 deltas 之外的单独清单。 */
      if (op.op === 'insert' && /(^|\/)-$/.test(String(op.path))) {
        appends.push({ segs: segs.slice(0, -1), value: op.value });
        return;
      }
      var cur = root;
      for (var i = 0; i < segs.length - 1; i++) {
        if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
        cur = cur[segs[i]];
      }
      cur[segs[segs.length - 1]] = op.value;
    });
    return { patch: root, removals: removals, deltas: deltas, appends: appends };
  }
  /* 增量落到现有值上：非数字一律不当增量（当 0，不写坏原值） */
  function applyDeltas(base, deltas) {
    var n = 0;
    (deltas || []).forEach(function (d) {
      var cur = base;
      for (var i = 0; i < d.segs.length - 1; i++) {
        if (!cur || typeof cur !== 'object') return;
        cur = cur[d.segs[i]];
      }
      if (!cur || typeof cur !== 'object') return;
      var last = d.segs[d.segs.length - 1];
      var old = Number(cur[last]);
      if (!isFinite(old)) return;          /* 原来不是数字 ⇒ 不动，别把字符串变成 NaN */
      cur[last] = Math.round((old + d.value) * 1000) / 1000;
      n++;
    });
    return n;
  }
  /* 数组 `-` 追加：MVU 的 insert 语义是「加到末尾」，对象上则是普通赋值 */
  function applyAppends(base, appends) {
    var n = 0;
    (appends || []).forEach(function (a) {
      var cur = base;
      for (var i = 0; i < a.segs.length; i++) {
        if (!cur || typeof cur !== 'object') return;
        cur = cur[a.segs[i]];
      }
      if (!cur || typeof cur !== 'object') return;
      if (Array.isArray(cur)) { cur.push(a.value); n++; }
    });
    return n;
  }
  /* 删干净：数组下标走 splice，对象键走 delete；中间层不存在就当已经没了 */
  function applyRemovals(base, removals) {
    var n = 0;
    (removals || []).forEach(function (segs) {
      var cur = base;
      for (var i = 0; i < segs.length - 1; i++) {
        if (!cur || typeof cur !== 'object') return;
        cur = cur[segs[i]];
      }
      if (!cur || typeof cur !== 'object') return;
      var last = segs[segs.length - 1];
      if (Array.isArray(cur)) {
        var idx = parseInt(last, 10);
        if (!isNaN(idx) && idx >= 0 && idx < cur.length) { cur.splice(idx, 1); n++; }
      } else if (Object.prototype.hasOwnProperty.call(cur, last)) {
        delete cur[last]; n++;
      }
    });
    return n;
  }
  function deepMergeInto(base, patch) {
    if (!base || !patch || typeof patch !== 'object') return base;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!base[k] || typeof base[k] !== 'object' || Array.isArray(base[k])) base[k] = {};
        deepMergeInto(base[k], v);
      } else if (v === undefined) {
        delete base[k];
      } else {
        base[k] = v;
      }
    });
    return base;
  }

  /* 写回：MVU 实例（chat + 本楼）→ 系统变量兜底。replaceMvuData 是 Promise，必须 await。 */
  /* ★★★ v431：这里踩过一个**会重复扣血**的坑，改 delta 时差点留下 ★★★
     `targets` 是**三层**（chat 全局 / 本楼 / latest 那楼），下面 forEach 对**每一层**
     都重新 getMvuData → 改 → replaceMvuData。
     原来全是 replace（写最终值）时这样写没问题：同样的值写三遍还是那个值。
     但 v429 加了 `delta`（相对加减）之后，同一个增量会被执行 **3 次** ——
     `气血 -15` 变成 -45，`经验值 +200` 变 +600。
     这不是理论风险：三层通常指向同一份 stat_data 或互相继承，改一层就够。
     ⇒ 增量和追加**只在第一层（chat 全局）算一次**，后面几层只吃 replace / remove
       （它们天然幂等，写几遍都一样）。 */
  function applyOps(ops, targetIdx) {
    var packed = opsToNested(ops);
    var nested = packed.patch;
    var removals = packed.removals;
    var deltas = packed.deltas;
    var appends = packed.appends;
    var ok = 0, errs = [];
    var targets = [{ type: 'chat' }];
    if (targetIdx != null && targetIdx >= 0) targets.push({ type: 'message', message_id: targetIdx });
    targets.push({ type: 'message', message_id: 'latest' });

    var mvu = null;
    var cands = windows();
    for (var i = 0; i < cands.length && !mvu; i++) {
      try { if (cands[i] && cands[i].Mvu) mvu = cands[i].Mvu; } catch (e) {}
    }

    var chain = Promise.resolve();
    if (mvu && typeof mvu.getMvuData === 'function' && typeof mvu.replaceMvuData === 'function') {
      targets.forEach(function (t, ti) {
        chain = chain.then(function () {
          return new Promise(function (res) {
            var root = null;
            try { root = mvu.getMvuData(t); } catch (e0) { root = null; }
            if (!root || typeof root !== 'object') root = { stat_data: {} };
            var base = root.stat_data || root.sata_data;
            if (!base || typeof base !== 'object') { base = {}; root.stat_data = base; }
            deepMergeInto(base, nested);
            /* ★ v429 顺序：先合并 replace、再加 delta、再追加数组、最后删。
               增量必须落在**合并之后**的现有值上（先加再合并会被 replace 盖掉）；
               删除必须最后做（先删再加会把刚删的又建回来）。
               ★ v431：delta / append 只对**第一层**（chat 全局）执行一次，
                 详见本函数头注释「重复扣血」那一段。 */
            if (ti === 0) {
              applyDeltas(base, deltas);
              applyAppends(base, appends);
            }
            applyRemovals(base, removals);
            var pr = null;
            try { pr = mvu.replaceMvuData(root, t); } catch (e1) { errs.push('MVU 写入 ' + JSON.stringify(t) + ' 异常'); res(); return; }
            if (pr && typeof pr.then === 'function') {
              pr.then(function () { ok++; res(); }).catch(function (e2) { errs.push(String(e2 && e2.message || e2)); res(); });
            } else { ok++; res(); }
          });
        });
      });
    }
    return chain.then(function () {
      /* 系统变量兜底：MVU 完全不可用时也不至于一点没写。
         ★ v431：这条兜底原来只写 `nested`（= 只有 replace 那一层），
           delta / append / remove 全丢 —— 也就是说「MVU 挂了」的时候，
           气血掉了、物品用了、任务完成了，在这条路上**一条都不生效**，而玩家以为补算成功了。
           修法：先取当前 chat 变量当底，再照 MVU 那条路的顺序（合并 → 增量 → 追加 → 删除）算一遍。 */
      if (!ok) {
        try {
          if (typeof insertOrAssignVariables === 'function') {
            var cur = {};
            try {
              var gv = (typeof getVariables === 'function') ? getVariables({ type: 'chat' }) : null;
              var gb = gv && (gv.stat_data || gv.sata_data || gv);
              if (gb && typeof gb === 'object') cur = JSON.parse(JSON.stringify(gb));
            } catch (eGv) { cur = {}; }
            if (!cur || typeof cur !== 'object') cur = {};
            deepMergeInto(cur, nested);
            applyDeltas(cur, deltas);
            applyAppends(cur, appends);
            applyRemovals(cur, removals);
            insertOrAssignVariables({ stat_data: cur }, { type: 'chat' });
            ok++;
          }
        } catch (e3) { errs.push(String(e3 && e3.message || e3)); }
      }
      return { ok: ok, errs: errs };
    });
  }

  function buildBlock(analysis, ops) {
    var a = String(analysis || '').trim();
    if (!a) {
      a = '- 时间：剧情自然推进。\n' +
          '- 剧情变动：' + (ops.length ? '是' : '无') + '。\n' +
          '- 变量分析：\n' +
          (ops.length
            ? ops.map(function (o) { return '  - ' + o.path + ' → ' + JSON.stringify(o.value === undefined ? '' : o.value); }).join('\n')
            : '  - 本楼无常量数值变动。');
    }
    return '<UpdateVariable>\n<Analysis>\n' + a + '\n</Analysis>\n<JSONPatch>\n' +
      JSON.stringify(ops || [], null, 2) + '\n</JSONPatch>\n</UpdateVariable>';
  }

  /* 把补好的块塞回那一楼：**块以外的每个字都原样保留**，只换掉旧块那一小段。
     ★ v308 旧写法是「stripVarBlocks 剥掉旧块 → cleanProse + block 拼到末尾」，
       两个后果都是玩家报的：
         ① 剥的时候把思维链一起吃掉了（正则从 think 内部起算，见 §七 头注释）；
         ② 就算没吃，块也被搬到消息最末尾，`<StatusPlaceHolderImpl/>` 反而跑到变量块前面。
       改成**就地替换**：找出旧块的首尾，只替换这一段；找不到才追加（追加也放在
       `<StatusPlaceHolderImpl/>` **前面**，保持占位符永远收尾）。 */
  function findCloseTagFrom(s, from, tag) {
    var re = new RegExp('<\\s*\\/\\s*' + tag + '\\s*>', 'ig');
    re.lastIndex = from;
    var m = re.exec(s);
    return m ? m.index + m[0].length : -1;
  }
  function lastCloseTagEnd(s, tag) {
    var re = new RegExp('<\\s*\\/\\s*' + tag + '\\s*>', 'ig');
    var m, last = -1;
    while ((m = re.exec(s)) !== null) last = m.index + m[0].length;
    return last;
  }
  /* 返回 { text, spliced }：spliced=true 表示真的换掉了旧块（而不是追加） */
  function spliceVarBlock(raw, block) {
    var mk = maskReasoning(raw);
    var s = mk.text;
    var at = -1, endAt = -1;
    var open = /<\s*UpdateVariable\b[^>]*>/i.exec(s);
    if (open) {
      at = open.index;
      var close = findCloseTagFrom(s, open.index + open[0].length, 'UpdateVariable');
      if (close > 0) endAt = close;
      else {
        /* 只开没收（模型被截断）：吃到最后一个 </JSONPatch> 或 </Analysis> 为止，
           再不行就吃到结尾 —— 但**仅限思维链之外**，think 已被遮住。 */
        var t1 = lastCloseTagEnd(s, 'JSONPatch');
        var t2 = lastCloseTagEnd(s, 'Analysis');
        var tail = Math.max(t1, t2);
        endAt = tail > at ? tail : s.length;
      }
    } else {
      /* 没有 <UpdateVariable>，但有裸 <JSONPatch>/<Analysis>：当旧块从那儿开始 */
      var cands = [];
      var jp = /<\s*(?:JSONPatch|json_?patch)\b[^>]*>/i.exec(s);
      var an = /<\s*Analysis\b[^>]*>/i.exec(s);
      if (jp) cands.push(jp.index);
      if (an) cands.push(an.index);
      if (cands.length) {
        at = Math.min.apply(null, cands);
        var tail2 = Math.max(lastCloseTagEnd(s, 'JSONPatch'), lastCloseTagEnd(s, 'Analysis'));
        endAt = tail2 > at ? tail2 : s.length;
      }
    }
    if (at >= 0 && endAt > at) {
      return { text: unmaskReasoning(s.slice(0, at) + block + s.slice(endAt), mk.chunks), spliced: true };
    }
    /* 追加：优先塞在 <StatusPlaceHolderImpl/> 之前，让它继续收尾 */
    var ph = /<\s*StatusPlaceHolderImpl\s*\/\s*>/i.exec(s);
    var out;
    if (ph) {
      out = s.slice(0, ph.index) + block + '\n' + s.slice(ph.index);
    } else {
      out = s + (s.trim() ? '\n\n' : '') + block;
    }
    return { text: unmaskReasoning(out, mk.chunks), spliced: false };
  }

  /* 最后一道保险：写完必须自检「思维链一个字都没少」。
     少一个字符都不许落库 —— 宁可退回「原文 + 追加块」，也绝不吞玩家的 think。 */
  function keepReasoningIntact(raw, next) {
    var chunks = maskReasoning(raw).chunks;
    if (!chunks.length) return true;
    var got = maskReasoning(next).chunks;
    var joined = got.join('\u0000');
    for (var i = 0; i < chunks.length; i++) {
      if (joined.indexOf(chunks[i]) < 0) return false;
    }
    return true;
  }

  /* 把补好的块塞回那一楼：正文一个字都不动，只换掉/追加变量块 */
  function writeBackBlock(targetIdx, block) {
    var chat = chatArray();
    var m = chat[targetIdx];
    if (!m) return Promise.reject(new Error('目标楼层不存在'));
    var raw = msgText(m);
    var next = spliceVarBlock(raw, block).text;
    if (!keepReasoningIntact(raw, next)) {
      /* 兜底：块追加到末尾，原文一个字节不动 */
      next = raw + (raw.trim() ? '\n\n' : '') + block;
    }

    /* 走 swipe 的就改当前 swipe，别把别的 swipe 一起冲掉 */
    var swId = m.swipe_id != null ? m.swipe_id : 0;
    var payload = { message_id: targetIdx, message: next };
    if (m.swipes && m.swipes.length) {
      var sws = m.swipes.slice();
      var cur = sws[swId];
      sws[swId] = (cur && typeof cur === 'object') ? Object.assign({}, cur, { mes: next }) : next;
      payload.swipes = sws;
      payload.swipe_id = swId;
    }
    if (typeof setChatMessages === 'function') {
      return setChatMessages([payload], { refresh: 'affected' }).catch(function () {
        return setChatMessages([{ message_id: targetIdx, message: next }], { refresh: 'affected' });
      });
    }
    /* 兜底：直接改 ctx.chat */
    return new Promise(function (res, rej) {
      try {
        m.mes = next;
        if (m.swipes && m.swipes.length) {
          var cur2 = m.swipes[swId];
          if (cur2 && typeof cur2 === 'object') cur2.mes = next; else m.swipes[swId] = next;
        }
        var ctx = getContext();
        if (ctx && typeof ctx.saveChat === 'function') ctx.saveChat();
        res();
      } catch (e) { rej(e); }
    });
  }

  /* ══════════════════ 十一、主流程 ══════════════════ */
  function setStatus(status, text) {
    S.status = status;
    S.statusText = text || '';
    notifyStatus();
    if (S.panel) { try { renderPanel(); } catch (e) {} }
  }

  function pushHistory(rec) {
    try {
      rec.at = Date.now();
      S.history.unshift(rec);
      if (S.history.length > 8) S.history.length = 8;
      store(histKey(), JSON.stringify(S.history));
    } catch (e) {}
  }
  function loadHistory() {
    try {
      var raw = store(histKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function runComplete(mode) {
    if (S.running) return Promise.resolve({ skipped: 'running' });
    if (!S.settings) loadSettings();
    if (!S.settings.enabled) { toast('外置变量补全总开关是关的', 'error'); return Promise.resolve({ skipped: 'disabled' }); }

    var targetIdx = latestAiIndex();
    if (targetIdx < 0) { toast('没找到可补的 AI 楼层', 'error'); return Promise.resolve({ skipped: 'no-floor' }); }

    var chat = chatArray();
    var aiRaw = msgText(chat[targetIdx]);
    var userIdx = latestUserIndexBefore(targetIdx);
    var userRaw = userIdx >= 0 ? msgText(chat[userIdx]) : '';
    var proseAi = stripVarBlocks(aiRaw);
    var proseUser = stripVarBlocks(userRaw);

    S.running = true;
    setStatus('running', (mode === 'deep' ? '🧠 全文精细补算' : '⚡ 快速补算') + '进行中…');
    var t0 = Date.now();

    return loadWorldbook().then(function () {
      var sd = readState();
      var extra = '';
      if (mode === 'deep') {
        /* 精细模式：再多给几楼上下文（剥掉变量块，只留正文） */
        var lines = [];
        for (var i = Math.max(0, targetIdx - 6); i < targetIdx; i++) {
          var mm = chat[i];
          if (!mm) continue;
          var tx = stripVarBlocks(msgText(mm)).slice(0, 700);
          if (tx) lines.push((mm.is_user ? '【玩家】' : '【正文】') + tx);
        }
        extra = lines.join('\n');
      }
      var built = buildPrompt(mode, sd, { ai: proseAi, user: proseUser }, extra);
      S.lastSystem = built.system;
      S.lastPrompt = built.user;

      var msgs = [
        { role: 'system', content: built.system },
        { role: 'user', content: built.user }
      ];
      return executeApiCall(msgs, clamp(S.settings.maxTokens, 300, 8000));
    }).then(function (raw) {
      var ms = Date.now() - t0;
      S.lastRaw = raw;

      var parsed = parsePatch(raw);
      var clean = sanitizeOps(parsed.ops);
      if (!clean.keep.length && parsed.ops.length) {
        throw new Error('模型给的 ' + parsed.ops.length + ' 条补丁全部不合法，已拒绝写入：' + clean.dropped.slice(0, 3).join('；'));
      }
      var block = buildBlock(parsed.analysis, clean.keep);

      return applyOps(clean.keep, targetIdx).then(function (w) {
        return writeBackBlock(targetIdx, block).then(function () {
          return { ms: ms, ops: clean.keep, dropped: clean.dropped, block: block, write: w };
        });
      });
    }).then(function (res) {
      S.running = false;
      S.lastMissing = false;
      setStatus('ok', '补算完成（' + (res.ms / 1000).toFixed(1) + 's，写入 ' + res.ops.length + ' 条）');
      pushHistory({
        status: 'ok', ms: res.ms, n: res.ops.length,
        npcs: S.lastNpcs.slice(),
        summary: res.dropped.length ? ('剔掉 ' + res.dropped.length + ' 条非法') : '全部合法'
      });
      toast('✓ 变量补算完成：写入 ' + res.ops.length + ' 条' + (res.dropped.length ? '（剔掉 ' + res.dropped.length + ' 条非法）' : ''), 'success');
      try {
        var d = doc();
        if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          d.dispatchEvent(new CustomEvent('xz-var-completed', { detail: res }));
        }
      } catch (eD) {}
      return { ok: true, ms: res.ms, n: res.ops.length, dropped: res.dropped.length };
    }).catch(function (err) {
      S.running = false;
      var msg = String((err && err.message) || err);
      setStatus('bad', '补算失败：' + msg);
      pushHistory({ status: 'bad', ms: Date.now() - t0, n: 0, npcs: S.lastNpcs.slice(), summary: msg.slice(0, 60) });
      toast('变量补算出错：' + msg, 'error');
      return { ok: false, error: msg };
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     ★★★ v432：时讯专线 —— 「九州热议」与「闲杂事件」的独立更新通道
     ══════════════════════════════════════════════════════════════════════

     ── 用户要的是什么（2026-10-28 两轮对话定稿） ──────────────────────────
       「改为调用外置ai，去专门更新当前事件这个模块，特别是评论类，
         这样子就不用考虑主ai负担的问题了」
       「不搞成变量，而是搞成蓝灯世界书，懂吧？如果评论和闲杂事件都在变量里，
         变量就太多了，正文ai会被干扰」
       「肯定要给ai看啊他妈的，不给ai看，那他妈和没发生有什么区别」
       「每3天更新一次闲杂事件」「九州热议，就可以弄很多了，每个事件三到四个评论」
       「[命定之诗]总结助手就是总结之后注入世界书的」

     ── 于是这些内容**只能**落在常驻世界书条目里，不能进变量表 ─────────────
       两个约束同时成立：
         ① AI 每楼都要看得到 ⇒ 必须进上下文（所以不能藏进 chat_metadata 就完事）；
         ② 不能占 stat_data     ⇒ 《变量列表》条目会把整份 stat_data 序列化注入，
                                   几十条议论 = 每楼白烧几百 token，还会带偏注意力。
       两条路只有「常驻世界书条目」能同时满足 —— 这正是用户说的「蓝灯」。

     ── 实现照抄《命定之诗》总结助手（`_dj_summarizer.js` 里读出来的） ─────
       `getWorldbook(name)`           读整本        → Promise<entries>
       `updateWorldbookWith(name, fn)` 改整本       → fn(entries) 返回新 entries
       `createWorldbookEntries(name, [entry])` 新建条目
       条目的常驻位在 `strategy.type = "constant"`（即"蓝灯"）。
       ⚠ 它的 updater 有个必须照抄的细节：**返回类型要和入参一致**
         —— 入参是数组就返回数组，是 `{entries:[...]}` 就返回同形状。
         只认一种形状的话，某些酒馆版本会把整本书写成空。

     ── 为什么界面还要另存一份到聊天变量 ────────────────────────────────────
       `getWorldbook` 是**异步**的，而 05 的 `pageNowEvents()` 是**同步 build()**，
       渲染时拿不到 Promise。所以写入时双写：
         · 世界书条目 = 给 AI 看的那一份（带 <九州热议>/<闲杂事件> 标签的纯文本）
         · 聊天变量   = 给界面看的那一份（原始 JSON 串，界面自己画卡片）
       ⚠ **唯一写入口就是下面的 writeTicker()**，两边永远同源。
         任何"只改一边"的改动都会造成「界面显示的和 AI 看到的不是一回事」，
         而这种不一致玩家根本发现不了 —— 只会觉得"AI 老说些没发生过的事"。

     ── 节奏（用户定「加个上次更新日期的变量不就好了」） ────────────────────
       不记楼层计数，记游戏内日期：计数器要模型每楼 +1，漏一次就永久偏移且无人发现；
       日期是模型本来就在算的东西，而且贴合叙事（同一天里打十楼议论不该变）。
       但只看日期不够：「只对目前的事件议论」意味着**事件换了议论就得换**，
       哪怕同一天（上午打山贼、下午宗门被屠）。所以热议判两条：
         ① 事件标题串变了 ⇒ 立刻刷；
         ② 距上次刷新满 3 天 ⇒ 兜底刷（事件没变也让讨论往前走）。
       闲杂事件只看天数，满 3 天刷。
       节奏标记放**聊天变量**（不进 stat_data、不进世界书），只有本专线读写。
     ══════════════════════════════════════════════════════════════════════ */
  var TICK_HOT = '时讯·九州热议';
  var TICK_ODD = '时讯·闲杂事件';
  var TICK_HOT_DAYS = 3;        /* 热议兜底刷新间隔（天） */
  var TICK_ODD_DAYS = 3;        /* 闲杂事件刷新间隔（天） */
  /* 聊天变量里的键。⚠ 统一加 xzTicker 前缀，别和别的脚本撞。 */
  var TK_HOT_DAY = 'xzTickerHotDay';
  var TK_HOT_EVT = 'xzTickerHotEvt';
  var TK_ODD_DAY = 'xzTickerOddDay';
  var TK_HOT_UI = 'xzTickerHotUI';
  var TK_ODD_UI = 'xzTickerOddUI';

  /* 聊天变量读写（不进 stat_data —— 这是本专线存在的意义之一） */
  function tkGet(key) {
    try {
      if (typeof getVariables === 'function') {
        var v = getVariables({ type: 'chat' });
        if (v && typeof v === 'object' && key in v) return v[key];
      }
    } catch (e0) {}
    try {
      var c = getContext();
      var cv = c && c.chatMetadata && c.chatMetadata.variables;
      if (cv && typeof cv === 'object' && key in cv) return cv[key];
    } catch (e1) {}
    return '';
  }
  function tkSet(obj) {
    try {
      if (typeof insertOrAssignVariables === 'function') { insertOrAssignVariables(obj, { type: 'chat' }); return true; }
    } catch (e0) {}
    try {
      var c = getContext();
      if (c && c.chatMetadata) {
        c.chatMetadata.variables = c.chatMetadata.variables || {};
        Object.keys(obj).forEach(function (k) { c.chatMetadata.variables[k] = obj[k]; });
        return true;
      }
    } catch (e1) {}
    return false;
  }

  /* 从《近期大事件》里拆出事件标题。
     格式与 05 的 pageNowEvents 同一套：`【类别·标题·地点】描述`，一行一件。
     ⚠ 别在这里另写一套解析：两处不一致 = 「界面上有三个事件，AI 只议论了两个」。 */
  function tkEventList(text) {
    var out = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      var t = String(line || '').trim();
      if (!t) return;
      var hit = /^【([^·】]+)·([^·】]+)(?:·([^】]+))?】\s*([\s\S]*)$/.exec(t);
      if (hit) {
        out.push({ cat: hit[1].trim(), title: hit[2].trim(), place: (hit[3] || '').trim(), desc: (hit[4] || '').trim() });
      } else {
        /* 没按格式写的：整行当一条「大势」，标题取前 12 字 —— 有事件就得有人议论，
           不能因为格式不规范就当作"没有事件"，那会让热议永远空着。 */
        out.push({ cat: '大势', title: t.slice(0, 12), place: '', desc: t });
      }
    });
    return out;
  }

  /* `1年3月7日` → 天数。只用来判"够不够 3 天"，所以用 30 天/月简化（误差 ≤1 天，
     对 3 天的判据无影响）。解析不出来返回 null —— **宁可判"没到点"也不判"到点了"**：
     多刷一次是浪费一次 API，漏刷一次只是晚点更新，后者代价小得多。 */
  function tkDayNum(s) {
    var m = /(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日?/.exec(String(s || ''));
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (!isFinite(y) || !isFinite(mo) || !isFinite(d)) return null;
    return y * 360 + mo * 30 + d;
  }
  function tkDaysSince(lastDay, todayStr) {
    var a = tkDayNum(lastDay), b = tkDayNum(todayStr);
    if (a == null || b == null) return 0;      /* 算不出 ⇒ 当 0 天（不到点） */
    var diff = b - a;
    return isFinite(diff) && diff > 0 ? diff : 0;
  }

  /* 现在该不该刷。纯函数、无副作用，方便单独验。 */
  function tkPlan(sd) {
    var g = (sd && sd.全局) || {};
    var today = String((sd && sd.时间 && sd.时间.日期) || '').trim();
    /* ★ v509：`全局.近期大事件` 这个变量**已删**（用户要求），原来是唯一来源。
       现在优先问 05 现算（`__XZ05__.tianjiEventLines`），拿不到才退回旧字段 ——
       老存档里那一栏还有值，退回是为了不把人家已经滚出来的热议清空。 */
    var events = [];
    try {
        var _q5 = (typeof globalThis !== 'undefined') ? globalThis.__XZ05__ : null;
        if (_q5 && typeof _q5.tianjiEventLines === 'function') {
            events = tkEventList((_q5.tianjiEventLines() || []).join('\n'));
        }
    } catch (eEv) { events = []; }
    if (!events.length) events = tkEventList(g.近期大事件);
    var evtKey = events.map(function (e) { return e.title; }).join('/').slice(0, 200);
    var hotDay = String(tkGet(TK_HOT_DAY) || '').trim();
    var hotEvt = String(tkGet(TK_HOT_EVT) || '').trim();
    var oddDay = String(tkGet(TK_ODD_DAY) || '').trim();

    var evtChanged = (events.length > 0) && (evtKey !== hotEvt);
    var hotStale = !hotDay || tkDaysSince(hotDay, today) >= TICK_HOT_DAYS;
    var oddStale = !oddDay || tkDaysSince(oddDay, today) >= TICK_ODD_DAYS;

    return {
      today: today,
      events: events,
      evtKey: evtKey,
      needHot: !!(events.length && (evtChanged || hotStale)),
      needOdd: !!oddStale,
      why: evtChanged ? '事件换了' : (hotStale ? '到了刷新日' : ''),
      hotDay: hotDay, hotEvt: hotEvt, oddDay: oddDay
    };
  }

  /* 提示词：只干一件事，别把它写成一个通用补算器 */
  function buildTickerPrompt(plan, prose) {
    var sys = [];
    sys.push('你是《天元一界》修仙世界的「坊间时讯」编辑。你只输出一个 JSON 对象，不写小说、不解释、不寒暄。');
    sys.push('');
    sys.push('════ 今天的世界状态 ════');
    sys.push('日期：' + (plan.today || '（未知）'));
    try {
      var g = readState().地理 || {};
      sys.push('所在：' + [g.大位置, g.小位置].filter(Boolean).join(' · '));
    } catch (eG) {}
    sys.push('');
    sys.push('════ 当前正在发生的事件 ════');
    if (plan.events.length) {
      plan.events.forEach(function (e, i) {
        sys.push((i + 1) + '. 【' + e.cat + '·' + e.title + (e.place ? '·' + e.place : '') + '】' + (e.desc || ''));
      });
    } else {
      sys.push('（眼下没有登记在册的大事）');
    }
    sys.push('');
    sys.push('════ 最近这一楼发生了什么 ════');
    sys.push(String(prose || '（无正文）').slice(0, 2200));
    sys.push('');
    sys.push('════ 你要产出什么 ════');
    sys.push('{"热议":[{"事件":"事件标题","评论":[{"宗门":"势力名","身份":"身份","内容":"说的话"}]}],"闲杂":[{"地点":"具体地方","内容":"一句话"}]}');
    sys.push('');
    sys.push('热议要求：');
    sys.push('· 只议论上面「当前正在发生的事件」里的那几件事，**每件事各写 3 到 4 条评论**，一件都不能漏');
    sys.push('· 「事件」字段必须逐字抄事件标题，一个字都不许改（界面靠它分组，改了就对不上）');
    sys.push('· 每条评论是一个**具体的人**在背后嚼舌根：给个势力名（如 三剑宗／千机坊市／散修）+ 身份（如 外门弟子／茶摊老板／守山执事）+ 一句人话');
    sys.push('· 要有情绪、有立场、有具体细节：谁怕了、谁发了财、谁在打听、谁在说风凉话。' + '内容 20~40 字，别写成语录，要像真人在说话');
    sys.push('· 允许互相矛盾（有人说宗门赢了，有人说死了一半），谣言本来就该打架');
    sys.push('· 不许提主角的名字，坊间议论里不许出现「他/她」指代主角');
    sys.push('');
    sys.push('闲杂要求：');
    sys.push('· 3 条，全是**市井小事与趣事**：谁家狗下了崽、哪个摊子涨价、山门口有人摆摊算卦、谁家闺女相了亲');
    sys.push('· 不许写危机、不许写宗门大事、不许写战斗、不许写和主角有关的事 —— 那些是「事件」栏的活');
    sys.push('· 「地点」写具体一处（山门石阶／坊市东街／丹房后院），不要写州域名');
    sys.push('· 内容 15~30 字，要有画面感，读完能笑一下或者 "哦" 一声');
    sys.push('');
    sys.push('只输出 JSON，不要 ```json 代码块，不要任何前后说明。');
    return sys.join('\n');
  }

  /* 解析模型输出：容错到"能在里面找到第一个 JSON 对象"就够了 ——
     模型偶尔会加一句"好的，这是结果"或者包个代码块，不值得为此判失败。 */
  function parseTickerOut(raw) {
    var s = String(raw == null ? '' : raw).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) throw new Error('模型没有给出 JSON 对象');
    var obj = JSON.parse(s.slice(i, j + 1));
    var hot = Array.isArray(obj.热议) ? obj.热议 : [];
    var odd = Array.isArray(obj.闲杂) ? obj.闲杂 : [];
    /* 清洗：只留结构完整的条目，别让一个坏条目把整次刷新废掉 */
    var hotClean = [];
    hot.forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      var title = String(h.事件 || '').trim();
      if (!title) return;
      var cs = [];
      (Array.isArray(h.评论) ? h.评论 : []).forEach(function (c) {
        if (!c || typeof c !== 'object') return;
        var body = String(c.内容 || '').trim();
        if (!body) return;
        cs.push({ 宗门: String(c.宗门 || '散修').trim(), 身份: String(c.身份 || '').trim(), 内容: body });
      });
      if (cs.length) hotClean.push({ 事件: title, 评论: cs });
    });
    var oddClean = [];
    odd.forEach(function (o) {
      if (!o || typeof o !== 'object') return;
      var body = String(o.内容 || '').trim();
      if (!body) return;
      oddClean.push({ 地点: String(o.地点 || '').trim(), 内容: body });
    });
    return { hot: hotClean, odd: oddClean };
  }

  /* 把结构化数据翻成「给 AI 看的纯文本」（世界书条目的正文） */
  function tickerHotText(hot) {
    if (!hot.length) return '<九州热议>\n（眼下还没人开口）\n</九州热议>';
    var L = ['<九州热议>'];
    hot.forEach(function (g) {
      L.push('【' + g.事件 + '】');
      g.评论.forEach(function (c) {
        L.push('- ' + (c.宗门 || '散修') + (c.身份 ? '·' + c.身份 : '') + '：' + c.内容);
      });
    });
    L.push('</九州热议>');
    return L.join('\n');
  }
  function tickerOddText(odd) {
    if (!odd.length) return '<闲杂事件>\n（最近没什么闲话）\n</闲杂事件>';
    var L = ['<闲杂事件>'];
    odd.forEach(function (o) {
      L.push('- ' + (o.地点 ? o.地点 + '：' : '') + o.内容);
    });
    L.push('</闲杂事件>');
    return L.join('\n');
  }

  /* 找「卡自己的那本世界书」。
     ⚠ 别写成"拿第一本"：玩家可能挂了好几本补充书，
       写错书 = AI 永远看不到（因为那本书可能没启用），而界面上一切正常。
     优先级：角色卡绑定（primary）→ 角色卡附加 → 书名含「天元」的那本。 */
  function tickerBookName() {
    var names = [];
    try {
      if (typeof getCharWorldbookNames === 'function') {
        var bn = getCharWorldbookNames('current');
        if (bn && bn.primary) names.push(bn.primary);
        if (bn && Array.isArray(bn.additional)) bn.additional.forEach(function (x) { if (x) names.push(x); });
      }
    } catch (e0) {}
    if (names.length) return names[0];
    var all = [];
    try { if (typeof getWorldbookNames === 'function') all = getWorldbookNames() || []; } catch (e1) {}
    if (!Array.isArray(all)) all = [];
    for (var i = 0; i < all.length; i++) { if (/天元/.test(String(all[i]))) return all[i]; }
    return all[0] || '';
  }

  /* 写世界书条目。**这是唯一"让 AI 看到"的落点**，失败必须报出来，
     不能静默 —— 静默的后果是玩家以为在更新，而 AI 一直看到旧的。 */
  function writeWorldbookEntry(bookName, entryName, content) {
    return new Promise(function (resolve) {
      if (!bookName) { resolve({ ok: false, why: '找不到角色卡绑定的世界书' }); return; }
      /* ★ v526：这两个名字是**酒馆助手注入的全局**，不是本文件的声明。
         以前全靠 `typeof xxx === 'function'` 守卫——运行时不会炸，但 ESLint 的
         no-undef 会报（它只认"声明在哪"，不认"宿主注入"）。
         这里改成先从 globalThis 上取一个**明确的引用**：守卫与调用用同一个来源，
         既让静态分析看得见，也让"取到的不是函数"和"宿主没注入"能区分开
         （前者调用会抛、后者根本不该进这条分支）。 */
      var _G = (typeof globalThis !== 'undefined') ? globalThis : {};
      var _upd = (typeof _G.updateWorldbookWith === 'function') ? _G.updateWorldbookWith : null;
      var _crt = (typeof _G.createWorldbookEntries === 'function') ? _G.createWorldbookEntries : null;
      var hasUpdate = !!_upd;
      var hasCreate = !!_crt;
      if (!hasUpdate && !hasCreate) { resolve({ ok: false, why: '酒馆助手未提供写世界书的接口' }); return; }

      function done(ok, why) { resolve({ ok: ok, why: why || '' }); }

      var readP = null;
      try { readP = (typeof getWorldbook === 'function') ? getWorldbook(bookName) : null; } catch (eR) { readP = null; }
      Promise.resolve(readP).then(function (wb) {
        /* updater 必须保持入参的容器形状：数组返数组，对象返同形状对象。
           《命定之诗》就是这么写的（`Array.isArray(e)?t:{...e,entries:t}`），照抄。 */
        var updater = function (wbData) {
          var list = Array.isArray(wbData) ? wbData.slice() : ((wbData && Array.isArray(wbData.entries)) ? wbData.entries.slice() : []);
          var hit = -1;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && (list[i].name === entryName || list[i].comment === entryName)) { hit = i; break; }
          }
          if (hit >= 0) {
            var e = list[hit] = Object.assign({}, list[hit]);
            e.content = content;
            e.enabled = true;
            e.disable = false;
            if ('disabled' in e) e.disabled = false;
            /* 常驻位（蓝灯）。有的版本认 strategy，有的认 constant —— 两个都写。 */
            e.constant = true;
            e.strategy = Object.assign({}, e.strategy || {}, {
              type: 'constant',
              keys: e.strategy && Array.isArray(e.strategy.keys) ? e.strategy.keys : [entryName],
              keys_secondary: (e.strategy && e.strategy.keys_secondary) || { logic: 'and_any', keys: [] },
              scan_depth: (e.strategy && e.strategy.scan_depth) || 'same_as_global'
            });
          }
          return Array.isArray(wbData) ? list : Object.assign({}, wbData || {}, { entries: list });
        };

        if (hasUpdate) {
          Promise.resolve(_upd(bookName, updater)).then(function () {
            done(true);
          }).catch(function (eU) { done(false, '写世界书失败：' + String(eU && eU.message || eU)); });
          return;
        }
        /* 只有 create 没有 update：条目已存在就没法改了，只能报出来 */
        if (hit_exists(wb, entryName)) { done(false, '这本世界书没有 update 接口，条目已存在无法改写'); return; }
        Promise.resolve(_crt(bookName, [{
          name: entryName, content: content, enabled: true, constant: true,
          strategy: { type: 'constant', keys: [entryName], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
          position: { type: 'at_depth', role: 0, depth: 4, order: 1002 },
          probability: 100,
          recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
          effect: { sticky: null, cooldown: null, delay: null }
        }])).then(function () { done(true); })
          .catch(function (eC) { done(false, '新建世界书条目失败：' + String(eC && eC.message || eC)); });
      }).catch(function (e0) { done(false, '读世界书失败：' + String(e0 && e0.message || e0)); });

      function hit_exists(wb, nm) {
        var list = Array.isArray(wb) ? wb : ((wb && Array.isArray(wb.entries)) ? wb.entries : []);
        for (var i = 0; i < list.length; i++) { if (list[i] && (list[i].name === nm || list[i].comment === nm)) return true; }
        return false;
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ★★★ 世界书热更新（补丁通道）· v1.08 ★★★
     ──────────────────────────────────────────────────────────────────────────
     用户 2026-11-01：「现在搞世界书热更新。先简单测试一下，把姜绾绾的关键词
       新增一个三剑宗。」
     第一条补丁就是它 —— 但它不是重点，**通道本身**才是：通道通了，
     以后改世界书条目（关键词、正文、开关）都不用玩家重新导入卡。

     ── 为什么走"补丁"而不是"整本覆盖" ──────────────────────────────────
       整本覆盖会**把玩家自己加的条目、自己改过的内容一起抹掉**，而且不可逆。
       补丁只做声明过的改动，每加一条都要写清楚改谁、改什么。

     ── 幂等怎么做 ──────────────────────────────────────────────────────
       世界书里放一条 `[热更] 已应用`（`enabled: false`，不进上下文、玩家看不见），
       内容是 `{ver, at, log}`。启动时读它，`ver >= 当前补丁版本` 就直接跳过。
       ⚠ 只有"写成功了"才更新这个版本号 —— 写失败还标成功，等于这批补丁永远不再执行。

     ── 字段名为什么要写两遍（`key` 与 `keys`）────────────────────────────
       卡里（`character_book.entries`）字段叫 `key`；
       ST 内部 `world_info.entries` 也是 `key`；
       而酒馆助手的条目 API 多半用 `keys`。
       这套代码要同时面对两边 ⇒ **两个都写**。只写一个的话，另一半读到的还是旧的，
       表现就是"改了、也返回成功、但 AI 那边一个关键词都没多"。

     ── 失败必须出声 ────────────────────────────────────────────────────
       世界书写不进去时玩家毫无察觉，只会觉得"AI 怎么不提三剑宗"。
       所以失败要 console.warn + 在状态里记一笔，别塞进空 catch。
     ══════════════════════════════════════════════════════════════════════════ */
  var WBP_STATE = '[热更] 已应用';
  var WBP_VER = 5;
  /* ★★★ v1.14：改成**以酒馆助手真实数据形状为准** ★★★
     事故：v1.08~v1.13 一直"写入成功、关键词一个没多"。
     查酒馆扩展 JS-Slash-Runner 的源码（宿主侧扩展目录里的 dist 入口，不在本仓库）才看清：

       getWorldbook(name)  →  返回**数组**，条目是这样的：
         { uid, name, enabled,
           strategy: { type, keys: [...], keys_secondary: { logic, keys: [...] }, scan_depth },
           position: { type, role, depth, order },
           content, probability, recursion, effect, extra }

       写回时它走 `OH(entry)` 重新拼 ST 条目，**只读** `e.name` / `e.strategy.keys`。
       顶层 `comment`、`key`、`keys` 它**根本不看**。

     所以老写法 `hit.key = [...]` 等于把关键词写进了一个马上被丢弃的字段：
     日志说"加了"，条目上却一个都没有。状态条目更惨 —— 用 `comment` 起名，
     回写时 `name` 是空 ⇒ 世界书面板里多出**无名条目**（就是玩家看到的"多了几个条目"）。

     现在：`strategy.keys` 是唯一真身，`name` 是唯一真名；老字段仍然冗余写一份
     （万一哪天宿主换实现），但**判据只看新的**。

     ★ 另外两条：
       ① 不信状态条目里的 `ver` 当门禁 —— 它曾经记成"已应用"而实际没写进去，
          于是补丁永远不再跑。改成**每次按 addKeys 实查**，缺就补（幂等）。
       ② 没变化就**根本不调** `updateWorldbookWith` —— 它内部无条件 saveWorldInfo，
          就算你返回原数组也会重写一遍世界书文件、重绘面板。 */
  /* ★★★ v1.12：自动执行**重新打开** ★★★
     历史：v1.09 自动跑过一次，因为 updater 把 `entries` 的对象形状换成了数组，
     整本书结构损坏 ⇒ MVU 读不到《变量列表》⇒ 变量更新报错 ⇒ 05/07 连锁崩。
     v1.13 起改为"入参不是数组就原地不动"，不会再写坏结构。
     ⚠ 如果哪天又出现"导入后变量全线报错"，第一件事仍是把它改回 false。 */
  var WBP_AUTO = true;
  /* ★★★ 补丁表 = **期望终态清单**，不是历史日志 ★★★
     这一条的语义在 v1.15 被掰正过来，很重要：

       门禁是"每次按 addKeys / delKeys 实查"（见 `_wbpApply`），
       ⇒ 表里每一条**每次启动都会被重新施加一遍**。
       ⇒ 所以表的内容必须等于"这本书现在**应该**长什么样"，不能当成 changelog。
       ⇒ 想让某个改动**失效**（比如这次把三剑宗删掉），唯一正确做法就是
         **把那条从表里拿掉**，再写一条反向的。留着它 + 加一条反向的，
         两条会互相打架，谁在后面谁赢 —— 下个版本一改顺序就翻车。

     字段：
       v        版本序号（递增即可，只用于日志，不再当门禁）
       entry    条目名（= 酒馆助手条目里的 `name`，老格式里叫 `comment`）
       addKeys  必须**在**的关键词（缺就补）
       delKeys  必须**不在**的关键词（有就删）
       note     给人看的说明（写进状态条目的 log） */
  var WBP_PATCHES = [
    /* v1.15 那条 `delKeys:['三剑宗']` 已经验完并生效（实测 key 从 5 个回到 4 个）。
       v1.16 把它**换成**加回来 —— 不并排放：加删同存会互相打架，谁在后面谁赢。 */
    { v: 5, entry: '人物-姜绾绾', addKeys: ['三剑宗'], note: '把三剑宗加回来' }
  ];

  /* ── 条目形状小工具（全部以酒馆助手为准，老字段兜底） ────────────── */
  function _wbpStr(v) { return (v === undefined || v === null) ? '' : String(v); }
  function _wbpName(e) {
    if (!e) return '';
    var a = _wbpStr(e.name).trim();
    if (a) return a;
    var b = _wbpStr(e.comment).trim();
    if (b) return b;
    return _wbpStr(e.title).trim();
  }
  function _wbpKeys(e) {
    if (!e) return null;
    if (e.strategy && typeof e.strategy === 'object' && Array.isArray(e.strategy.keys)) return e.strategy.keys;
    if (Array.isArray(e.key)) return e.key;
    if (Array.isArray(e.keys)) return e.keys;
    return null;
  }
  /* 写关键词：strategy.keys 是真身，顶层 key/keys 冗余一份。
     ⚠ 必须**新建** strategy 对象再赋回，不能直接改 `e.strategy.keys` ——
       浅拷贝的条目会跟原对象共用同一个 strategy 引用，一改就污染源数据。 */
  function _wbpSetKeys(e, arr) {
    var a = arr.slice();
    if (!e.strategy || typeof e.strategy !== 'object' || Array.isArray(e.strategy)) {
      e.strategy = {
        type: e.constant ? 'constant' : 'selective',
        keys: a.slice(),
        keys_secondary: { logic: 'and_any', keys: Array.isArray(e.keysecondary) ? e.keysecondary.slice() : [] },
        scan_depth: 'same_as_global'
      };
    } else {
      e.strategy = Object.assign({}, e.strategy, { keys: a.slice() });
      if (!e.strategy.keys_secondary || typeof e.strategy.keys_secondary !== 'object') {
        e.strategy.keys_secondary = { logic: 'and_any', keys: [] };
      }
      if (!e.strategy.type) e.strategy.type = e.constant ? 'constant' : 'selective';
    }
    e.key = a.slice();
    e.keys = a.slice();
  }
  /* 名字双向补齐：宿主只认 `name`，卡格式只认 `comment`。
     只补不覆盖 —— 已有名字一个都不许动。 */
  function _wbpFixName(e) {
    if (!e || typeof e !== 'object') return;
    var nm = _wbpStr(e.name).trim();
    var cm = _wbpStr(e.comment).trim();
    if (!nm && cm) e.name = cm;
    if (!cm && nm) e.comment = nm;
  }
  /* 认状态条目：名字对，或"无名 + 无关键词 + content 是 {ver,log,at}"的孤儿。
     后者是 v1.13 之前的产物（当时用 comment 起名，回写时名字被抹成空） */
  function _wbpIsState(e) {
    if (!e || typeof e !== 'object') return false;
    if (_wbpName(e) === WBP_STATE) return true;
    if (_wbpName(e)) return false;
    var ks = _wbpKeys(e);
    if (ks && ks.length) return false;
    var c = _wbpStr(e.content).trim();
    if (c.charAt(0) !== '{') return false;
    try {
      var o = JSON.parse(c);
      return !!(o && typeof o.ver !== 'undefined' && Array.isArray(o.log));
    } catch (x) { return false; }
  }
  function _wbpStVer(e) {
    try {
      var o = JSON.parse(_wbpStr(e && e.content) || '{}') || {};
      return Number(o.ver) || 0;
    } catch (x) { return 0; }
  }
  function _wbpMakeState(stObj) {
    return {
      uid: Date.now(),
      name: WBP_STATE,
      comment: WBP_STATE,
      enabled: false,
      disable: true,
      content: JSON.stringify(stObj),
      strategy: {
        type: 'selective',
        keys: [WBP_STATE],
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: 'same_as_global'
      },
      position: { type: 'after_character_definition', role: 'system', depth: 4, order: 9999 },
      probability: 100,
      recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
      effect: { sticky: null, cooldown: null, delay: null },
      /* 老格式冗余（换实现时还有一层兜底）。注意 `position` 不能同时是数字，冲突时以新格式为准。 */
      key: [WBP_STATE],
      keys: [WBP_STATE],
      constant: false,
      selective: true,
      insertion_order: 9999,
      excludeRecursion: true,
      preventRecursion: true
    };
  }
  /* 在数组上做全部改动，返回 {list, need, changed, dup}。
     need=false 表示"一个字都不用改"，调用方就不要去碰写接口。 */
  function _wbpApply(arr) {
    var out = [];
    var i;
    for (i = 0; i < arr.length; i++) {
      var src = arr[i];
      if (!src || typeof src !== 'object') { out.push(src); continue; }
      var cp = Object.assign({}, src);
      _wbpFixName(cp);
      out.push(cp);
    }
    /* 状态条目：留第一条，其余删（玩家看到的"多出来几个条目"就是这些） */
    var sts = [];
    for (i = 0; i < out.length; i++) { if (_wbpIsState(out[i])) sts.push(i); }
    var keep = -1;
    var dup = 0;
    for (var t = 0; t < sts.length; t++) {
      var idx = sts[t];
      if (keep < 0) { keep = idx; continue; }
      out.splice(idx, 1);
      dup++;
      for (var u = t + 1; u < sts.length; u++) sts[u]--;
    }
    /* 关键词：**实查**，不看状态里的 ver */
    var changed = [];
    for (var p = 0; p < WBP_PATCHES.length; p++) {
      var patch = WBP_PATCHES[p];
      var hit = null;
      for (var j = 0; j < out.length; j++) {
        if (_wbpName(out[j]) === patch.entry) { hit = out[j]; break; }
      }
      if (!hit) { if (changed.indexOf('缺条目：' + patch.entry) < 0) changed.push('缺条目：' + patch.entry); continue; }
      var cur = _wbpKeys(hit);
      if (cur === null) cur = [];
      cur = cur.slice();
      var added = [];
      var removed = [];
      var addList = patch.addKeys || [];
      for (var q = 0; q < addList.length; q++) {
        if (cur.indexOf(addList[q]) < 0) { cur.push(addList[q]); added.push(addList[q]); }
      }
      /* delKeys：必须不在的，有就删。删是"从数组里剔除"，不是置空整个 keys ——
         其它关键词一个都不许动（玩家/AI 自己加的也算）。 */
      var delList = patch.delKeys || [];
      for (var d2 = 0; d2 < delList.length; d2++) {
        var at = cur.indexOf(delList[d2]);
        if (at >= 0) { cur.splice(at, 1); removed.push(delList[d2]); }
      }
      if (!added.length && !removed.length) continue;
      _wbpSetKeys(hit, cur);
      changed.push(patch.entry
        + (added.length ? ' +' + added.join('/') : '')
        + (removed.length ? ' -' + removed.join('/') : ''));
    }
    var need = (changed.length > 0) || (dup > 0) || (keep < 0);
    if (keep >= 0 && !need) {
      var se0 = out[keep];
      if (_wbpName(se0) !== WBP_STATE || _wbpStVer(se0) !== WBP_VER) need = true;
    }
    if (need) {
      var stObj = {
        ver: WBP_VER,
        at: new Date().toISOString(),
        log: changed.length ? changed : ['无需改动：关键词已在，仅整理状态条目']
      };
      if (keep >= 0) {
        var oldUid = out[keep].uid;
        var merged = Object.assign({}, out[keep], _wbpMakeState(stObj));
        if (oldUid !== undefined && oldUid !== null) merged.uid = oldUid;
        out[keep] = merged;
      } else {
        out.push(_wbpMakeState(stObj));
      }
    }
    return { list: out, need: need, changed: changed, dup: dup };
  }
  /* 写完回读验证 —— "返回成功"不算数，得在回读结果里看见关键词。
     addKeys 要**在**、delKeys 要**不在**，两个方向都验。 */
  function _wbpVerify(list) {
    var bad = [];
    for (var p = 0; p < WBP_PATCHES.length; p++) {
      var patch = WBP_PATCHES[p];
      var hit = null;
      for (var j = 0; j < list.length; j++) { if (_wbpName(list[j]) === patch.entry) { hit = list[j]; break; } }
      if (!hit) { bad.push(patch.entry + '·条目没找到'); continue; }
      var cur = _wbpKeys(hit) || [];
      var miss = [];
      var left = [];
      var addList = patch.addKeys || [];
      for (var q = 0; q < addList.length; q++) { if (cur.indexOf(addList[q]) < 0) miss.push(addList[q]); }
      var delList = patch.delKeys || [];
      for (var d3 = 0; d3 < delList.length; d3++) { if (cur.indexOf(delList[d3]) >= 0) left.push(delList[d3]); }
      if (miss.length) bad.push(patch.entry + '·仍缺 ' + miss.join('/'));
      if (left.length) bad.push(patch.entry + '·没删掉 ' + left.join('/'));
    }
    return bad;
  }

  function wbpApply() {
    var book = tickerBookName();
    if (!book) {
      try { console.warn('[天元录·世界书热更] 找不到卡绑定的世界书，本批补丁跳过'); } catch (e) {}
      return Promise.resolve({ ok: false, why: 'no-book' });
    }
    var _G = (typeof globalThis !== 'undefined') ? globalThis : {};
    var _get = (typeof _G.getWorldbook === 'function') ? _G.getWorldbook : null;
    var _upd = (typeof _G.updateWorldbookWith === 'function') ? _G.updateWorldbookWith : null;
    if (!_upd) {
      try { console.warn('[天元录·世界书热更] 宿主没有 updateWorldbookWith，本批补丁跳过'); } catch (e) {}
      return Promise.resolve({ ok: false, why: 'no-api' });
    }
    var changedAll = [];

    function doWrite() {
      var r;
      try {
        r = _upd(book, function (wbData) {
          /* ⚠ 入参不是数组 ⇒ 什么都不动，原样还回去。
             这里换了形状会把整本书写坏（v1.09 事故）。宁可不生效，不许写坏。 */
          if (!Array.isArray(wbData)) {
            try { console.warn('[天元录·世界书热更] 世界书不是数组形状，为免写坏整本书，本次放弃写入'); } catch (e1) {}
            return wbData;
          }
          var res = _wbpApply(wbData);
          changedAll = res.changed.slice();
          return res.list;
        });
      } catch (eCall) {
        try { console.warn('[天元录·世界书热更] 调用写接口就抛了：' + String(eCall && eCall.message || eCall)); } catch (e2) {}
        return Promise.resolve({ ok: false, why: String(eCall && eCall.message || eCall) });
      }
      return Promise.resolve(r).then(function (after) {
        var logTxt = changedAll.length ? changedAll.join('；') : '无改动';
        if (!Array.isArray(after)) {
          try { console.log('[天元录·世界书热更] 已应用到 v' + WBP_VER + '｜' + logTxt + '（宿主没回读，无法二次验证）'); } catch (e3) {}
          return { ok: true, changed: changedAll, verified: null };
        }
        var bad = _wbpVerify(after);
        if (bad.length) {
          try { console.warn('[天元录·世界书热更] ⚠ 写完了但回读不对：' + bad.join('；') + '｜已写：' + logTxt); } catch (e4) {}
          return { ok: false, changed: changedAll, bad: bad, why: bad.join('；') };
        }
        try { console.log('[天元录·世界书热更] 已应用到 v' + WBP_VER + '｜' + logTxt + '｜回读验证：关键词全部在'); } catch (e5) {}
        return { ok: true, changed: changedAll, verified: true };
      }, function (e) {
        try { console.warn('[天元录·世界书热更] 写入失败（AI 那边还是旧的）：' + String(e && e.message || e)); } catch (e6) {}
        return { ok: false, why: String(e && e.message || e) };
      });
    }

    /* 先读一遍做"要不要动"的判断：没变化就一次都不写（写接口内部无条件落盘+重绘） */
    var readP = null;
    if (_get) {
      try { readP = Promise.resolve(_get(book)); } catch (eR) { readP = null; }
    }
    if (!readP) return doWrite();
    return readP.then(function (wb) {
      if (Array.isArray(wb)) {
        var pre = _wbpApply(wb);
        if (!pre.need) {
          try { console.log('[天元录·世界书热更] 无需写入：关键词已在，状态 v' + WBP_VER); } catch (e7) {}
          return { ok: true, changed: [], skipped: true, verified: true };
        }
      }
      return doWrite();
    }, function () { return doWrite(); });
  }

  /* ★ v1.08：把补丁入口挂出去 —— 两个用途：
     ① 单测（`工具/_v108_wb_patch.mjs`）能直接调，不用整个 08 跑起来；
     ② 玩家侧出了问题，作者可以在控制台 `__XZ_WBP__.apply()` 手动重跑一次看结果。 */
  try {
    if (typeof globalThis !== 'undefined') {
      globalThis.__XZ_WBP__ = {
        ver: WBP_VER,
        patches: WBP_PATCHES,
        stateEntry: WBP_STATE,
        apply: wbpApply
      };
    }
  } catch (eExpWbp) {}

  /* 双写：世界书（给 AI）+ 聊天变量（给界面）。两边内容必须同源。 */
  function writeTicker(res, plan) {
    var hotText = tickerHotText(res.hot);
    var oddText = tickerOddText(res.odd);
    var book = tickerBookName();
    var jobs = [];
    if (res.hot.length) jobs.push(writeWorldbookEntry(book, TICK_HOT, hotText));
    if (res.odd.length) jobs.push(writeWorldbookEntry(book, TICK_ODD, oddText));

    return Promise.all(jobs).then(function (rs) {
      var bad = rs.filter(function (x) { return x && !x.ok; });
      /* 界面那一份无论如何都写 —— 世界书写不进去时，界面至少还能给玩家看，
         但要同时把"AI 看不到"这件事明确告诉他。 */
      var v = {};
      if (res.hot.length) {
        v[TK_HOT_UI] = JSON.stringify(res.hot);
        v[TK_HOT_DAY] = plan.today || '';
        v[TK_HOT_EVT] = plan.evtKey || '';
      }
      if (res.odd.length) {
        v[TK_ODD_UI] = JSON.stringify(res.odd);
        v[TK_ODD_DAY] = plan.today || '';
      }
      tkSet(v);
      return { ok: !bad.length, bad: bad, book: book, hotText: hotText, oddText: oddText };
    });
  }

  /* 主流程 */
  function runTicker(force) {
    /* ★★★ v489：时讯专线**整条下架**，这里是最前面那道闸（用户 2026-10-31）。
       为什么封在函数入口而不是逐个删调用点：全仓有 4 处调它（面板按钮 / 自定义事件 /
       bridge 出口 / 旧路径），一处处删是漏改温床 —— 删漏一处就变成
       「点了还在发 API 请求，但世界书里已经没有那两条可写」的半死状态。
       ⚠ 世界书《时讯·九州热议》《时讯·闲杂事件》已移进 世界书/归档/_v489_下架资讯球与时讯/，
         pack.js 不会打包它们。往一个不存在的条目里写 = 每轮白烧一次 API。 */
    return Promise.resolve({ skipped: 'retired', why: '时讯已于 v489 下架（玩家自己看《事件总表》）' });
    /* eslint-disable no-unreachable */
    if (S.running) return Promise.resolve({ skipped: 'running' });
    if (!S.settings) loadSettings();
    if (!S.settings.enabled) { toast('外置变量补全总开关是关的', 'error'); return Promise.resolve({ skipped: 'disabled' }); }

    var sd = readState();
    var plan = tkPlan(sd);
    if (!force) {
      if (!plan.needHot && !plan.needOdd) return Promise.resolve({ skipped: 'not-due' });
      if (!plan.events.length && !plan.needOdd) return Promise.resolve({ skipped: 'no-event' });
    }
    if (force && !plan.events.length) {
      /* 玩家手动点：没事件就只刷闲杂 —— 别拿"没有事件"当拒绝理由，
         玩家点这个按钮就是想看到点新东西。 */
      plan.needOdd = true;
    }

    var targetIdx = latestAiIndex();
    var prose = '';
    if (targetIdx >= 0) {
      var chat = chatArray();
      var lines = [];
      for (var i = Math.max(0, targetIdx - 2); i <= targetIdx; i++) {
        var m = chat[i]; if (!m) continue;
        var tx = stripVarBlocks(msgText(m)).slice(0, 900);
        if (tx) lines.push((m.is_user ? '【玩家】' : '【正文】') + tx);
      }
      prose = lines.join('\n');
    }

    S.running = true;
    setStatus('running', '📰 时讯刷新中…');
    var t0 = Date.now();
    var prompt = buildTickerPrompt(plan, prose);
    S.lastSystem = prompt;
    S.lastPrompt = '';

    return executeApiCall([{ role: 'system', content: prompt }, { role: 'user', content: '按上面的要求输出 JSON。' }],
      clamp(S.settings.maxTokens, 300, 8000)).then(function (raw) {
      S.lastRaw = raw;
      var res = parseTickerOut(raw);
      if (!res.hot.length && !res.odd.length) throw new Error('模型给的热议与闲杂都是空的');
      /* 热议没要求刷的时候，即使模型给了也别覆盖旧的 —— 否则相当于把节奏判据废了 */
      if (!plan.needHot) res.hot = [];
      if (!plan.needOdd) res.odd = [];
      return writeTicker(res, plan).then(function (w) {
        S.running = false;
        var ms = Date.now() - t0;
        var n = ((res.hot || []).reduce(function (a, g) { return a + g.评论.length; }, 0)) + (res.odd || []).length;
        setStatus(w.ok ? 'ok' : 'warn',
          (w.ok ? '时讯已更新（' : '时讯只更新了界面（') + n + ' 条，' + (ms / 1000).toFixed(1) + 's' +
          (w.ok ? '' : '；世界书写入失败：' + (w.bad[0] && w.bad[0].why)) + '）');
        pushHistory({ status: w.ok ? 'ok' : 'warn', ms: ms, n: n, npcs: [], summary: '时讯：热议 ' + (res.hot || []).length + ' 组 / 闲杂 ' + (res.odd || []).length + ' 条' });
        if (w.ok) {
          toast('📰 时讯已更新：' + n + ' 条' + (plan.why ? '（' + plan.why + '）' : ''), 'success');
        } else {
          toast('⚠ 时讯界面已更新，但写世界书失败：' + (w.bad[0] && w.bad[0].why) + '（AI 可能看不到新议论）', 'error', 6000);
        }
        try {
          var d = doc();
          if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            d.dispatchEvent(new CustomEvent('xz-ticker-updated', { detail: { hot: res.hot, odd: res.odd } }));
          }
        } catch (eD) {}
        return { ok: w.ok, n: n, hot: (res.hot || []).length, odd: (res.odd || []).length };
      });
    }).catch(function (err) {
      S.running = false;
      var msg = String((err && err.message) || err);
      setStatus('bad', '时讯刷新失败：' + msg);
      toast('时讯刷新出错：' + msg, 'error');
      return { ok: false, error: msg };
    });
  }

  /* ★★★ v446：`maybeTicker()` 整段**删除**（用户 2026-10-29：
     「一进卡第一瞬间就是疯狂调动 api 去生成那些事件，你让玩家自己按啊」）。
     原来这里是个自动触发器：挂在 GENERATION_ENDED / GENERATION_STOPPED /
     MESSAGE_RECEIVED 三个事件上，判断「到点了」就自己 runTicker(false) 发请求。
     一进卡那一下，酒馆会把历史楼层逐层重放，每层都触发 MESSAGE_RECEIVED ——
     于是"开卡瞬间"就等于"连问好几次"；再加上新存档的两个日期变量是空的，
     恒判「从来没刷过」，所以第一次必然真发。
     ⇒ 现在时讯只走手动一条路：`__xzVarComplete.ticker()` / 「目前事件」页的刷新按钮
       / 设置页 verbal 都没有自动入口。`tickerAuto` 那个开关保留但恒为 false（见 loadSettings）。
     ⚠ 以后要恢复自动，别在原处加回来 —— 必须先解决"重放历史楼层不算事件"这一层，
       否则同样的病会立刻复发。 */

  /* 面板上那句「为什么现在刷 / 为什么不刷」—— 玩家看不到判据就会觉得"怎么没动" */
  function tickerPlanTip() {
    try {
      var plan = tkPlan(readState());
      var parts = [];
      parts.push('今天 ' + (plan.today || '?') + '｜事件 ' + plan.events.length + ' 件');
      parts.push('热议 ' + (plan.needHot ? ('该刷了' + (plan.why ? '（' + plan.why + '）' : '')) : ('上次 ' + (plan.hotDay || '从没刷过'))));
      parts.push('闲杂 ' + (plan.needOdd ? '该刷了' : ('上次 ' + (plan.oddDay || '从没刷过'))));
      return parts.join('｜');
    } catch (e0) { return '时讯节奏读取失败'; }
  }

  /* ══════════════════ 十二、实时嗅探：最新楼层的变量**格式**对不对 ══════════════════
     ★ 只查格式（<UpdateVariable> 标签闭合 + <JSONPatch> JSON 闭合），
       不再逐项检测「缺哪个变量」（伤势/姓名/境界/时间/地理…）。 */
  /* ★ v3（用户口径）：变量补全只认「格式」，**绝不逐项检测「缺哪个变量」**。
     只做两件事：
       ① 变量标签 <UpdateVariable> 是否成对闭合；
       ② 标签里的 <JSONPatch> JSON 数组是否闭合（能解析成数组）。
     「主角信息有没有伤势/境界」「时间有没有日期」「地理有没有小位置」——
     这些都不归补全脚本管，一律不再检测。 */
  function checkVarFormat(patchText) {
    var problems = [];
    var raw = String(patchText || '');
    if (!raw.trim()) { problems.push('本楼没有变量块'); return problems; }
    /* ★ v308：只看思维链**之外**。think 里写草稿、或只是提了一句标签名，
       都不许污染正文的判定（旧写法两样都会误判成「格式正常/格式错误」）。 */
    var s = withoutReasoning(raw);
    var rawHasTag = /<\s*UpdateVariable\b[^>]*>/i.test(raw);
    if (!/<UpdateVariable\b[^>]*>/i.test(s)) {
      if (rawHasTag) {
        /* 块写在 think 里了：这已经是根因，别再叠一条「JSON 缺失」去误导玩家改错地方 */
        problems.push('变量块写在思维链里（MVU 读不到，得挪到正文）');
        return problems;
      }
      problems.push('缺少 <UpdateVariable> 起始标签');
    } else if (!/<\/UpdateVariable\s*>/i.test(s)) {
      problems.push('<UpdateVariable> 标签未闭合');
    }
    if (!hasCompletePatch(raw)) problems.push('<JSONPatch> 缺失或 JSON 未闭合');
    return problems;
  }

  /* ─────────────────────────────────────────────────────────────
     ★ v76（2026-10-15）：嗅探时机全面改抄《同层版·春日狂想曲》v97 的做法。

       · 主路 = 心跳「**每 2 秒轮询一次**」（pollSniff）。
         不再以「推进结束」为唯一入口 —— 点推进 / 切聊天 / 翻历史楼层 /
         swipe 换回复 / 重新生成 / 自动续写 / 中途打断，全都会查。
       · 唯一抑制条件 = **正在生成中**（正文还在流、变量块还没写完）→ 此刻查必误报。
         `is_generating` 在某些酒馆版本「刚点发送那一瞬」还没置上，所以再补一道
         「正文长度连续两轮不变」的闸兜底。
       · 同一楼只提示一次（_sniffedKey 去重），绝不每 2 秒反复骚扰。
       · 异常要「**二次确认**」：首次发现只记下不弹，持续到下一个轮询周期仍异常才真弹，
         避开「正文刚落地、MVU 还没解析落库」这一瞬的误报。
       · 嗅到异常 **只弹一条轻提示（toast）+ 状态栏亮 ❌ 红标**，
         **绝不**自动弹「🩺 变量补全」面板、**绝不**挂起/遮挡玩家。
         想看详情、想补算，玩家自己点状态栏那颗按钮（openPanel）。
       · 快速通道：GENERATION_ENDED / STOPPED / MESSAGE_RECEIVED 时跳过节流立刻补查一次。
     ───────────────────────────────────────────────────────────── */
  var _lastReportedMissingKey = null;

  var POLL_SNIFF_MS = 2000;      /* ★ v76：轮询嗅探间隔 —— 每 2 秒查一次 */
  var CONFIRM_ISSUE_MS = 1900;   /* ★ v76：异常需持续这么久才真弹（≥ 一个轮询周期） */
  var _pollAt = 0;               /* 上一次轮询嗅探的时刻（节流用） */
  var _sniffArmed = false;       /* 本会话是否已观察过一轮生成（未武装不嗅，免得拿历史楼层误报） */
  var _sniffedKey = '';          /* 已经提示过的楼层 —— 同一楼只弹一次 */
  var _pendingKey = '';          /* 疑似异常的楼层（等下一轮复核，防误报） */
  var _pendingAt = 0;            /* 第一次发现异常的时刻 */
  var _lastLen = -1;             /* 上一次看到的最新一楼正文长度（还在变＝还在流，不查） */
  var _lastSniffIdx = -1;        /* 上一次查的是哪一楼（换楼时长度闸归零） */

  function resetSniffState() {
    _sniffedKey = ''; _pendingKey = ''; _pendingAt = 0;
    _sniffArmed = false; _pollAt = 0; _lastLen = -1; _lastSniffIdx = -1;
  }

  /* ★ v76：格式异常的唯一出口 = 一条轻提示 + 亮状态栏红标。
     **绝不**自动弹「🩺 变量补全」面板，**绝不**把玩家卡住。 */
  function notifyIssue(problems) {
    try {
      var arr = problems || [];
      var n = arr.length || 1;
      var detail = arr.slice(0, 4).join('、') + (arr.length > 4 ? (' 等共 ' + n + ' 项') : '');
      toast('⚠【天元一界】变量块格式异常：' + detail + '（点状态栏「🩺 变量补全」可查看 / 补算）', 'warning', 5600);
    } catch (eN) {}
  }

  /* 重新点一下状态栏红标／恢复正常时用：清掉异常态并刷新按钮颜色 */
  function clearMissingFlag() {
    if (!S.lastMissing && (!S.missingList || !S.missingList.length)) return;
    S.lastMissing = false; S.missingList = [];
    try { notifyStatus(); } catch (e) {}
  }

  /* 「是不是还在生成中」—— 酒馆全局标记（长度闸在 pollSniff 里单独做）。 */
  function isSnapshotStreaming() {
    try {
      if (typeof is_generating !== 'undefined' && is_generating) return true;
      if (window.parent && typeof window.parent.is_generating !== 'undefined' && window.parent.is_generating) return true;
      if (window.top && typeof window.top.is_generating !== 'undefined' && window.top.is_generating) return true;
    } catch (eGen) {}
    return false;
  }

  /* ★★ v76：轮询嗅探（主路）。心跳每 700ms 调一次，函数内部按 2 秒节流。 */
  function pollSniff(force) {
    var now = Date.now();
    if (now - _pollAt < POLL_SNIFF_MS) return true;      /* 2 秒节流 */
    _pollAt = now;
    if (!S.settings) loadSettings();
    if (!S.settings.sniffer) { clearMissingFlag(); return true; }
    if (S.running) return true;                          /* 正在补算 → 不重复弹 */
    /* 本会话还没观察过一轮完整生成（刚载页 / 刚切聊天）→ 不嗅，免得拿历史楼层误报 */
    if (!_sniffArmed) return true;

    var idx = latestAiIndex();
    if (idx < 0) { clearMissingFlag(); return true; }
    var chat = chatArray();
    var txt = msgText(chat[idx]);
    if (!txt) return true;                               /* 空楼＝还没写，等下一轮 */

    /* 换楼：长度闸与待确认状态都归零，免得拿上一楼的数据判这一楼 */
    if (idx !== _lastSniffIdx) {
      _lastSniffIdx = idx; _lastLen = -1; _pendingKey = ''; _pendingAt = 0;
    }
    /* 长度闸：这一轮长度变了＝正文还在长，本轮不判，下一轮再看 */
    var len = String(txt).length;
    var grew = (len !== _lastLen);
    _lastLen = len;
    if (isSnapshotStreaming() || grew) return true;

    var problems = checkVarFormat(txt);
    var key = 'p' + idx;

    if (_sniffedKey === key) {                           /* 这一楼已经提示过 → 只复查红标该不该熄 */
      if (problems.length === 0) clearMissingFlag();
      return problems.length === 0;
    }
    if (problems.length === 0) {                         /* 格式正常 → 清掉待确认状态与红标 */
      _pendingKey = ''; _pendingAt = 0;
      clearMissingFlag();
      return true;
    }
    /* ★ 二次确认：首次发现「不对劲」只记下，不立刻弹。
       长楼层 / MVU 解析慢时，正文刚落地这一刻变量块可能还没写完，
       立刻弹＝误报骚扰玩家。等它持续到下一个轮询周期仍然异常，才真弹。 */
    if (_pendingKey !== key) { _pendingKey = key; _pendingAt = now; return false; }
    if (now - _pendingAt < CONFIRM_ISSUE_MS) return false;
    _pendingKey = ''; _pendingAt = 0;
    _sniffedKey = key;
    S.lastMissing = true; S.missingList = problems.slice();
    try { notifyStatus(); } catch (eN) {}
    notifyIssue(problems);
    if (force && S.settings.autoRepair && !S.running) {
      if (S.pendingTimer) clearTimeout(S.pendingTimer);
      S.pendingTimer = setTimeout(function () { S.pendingTimer = null; runComplete('fast'); }, 800);
    }
    return false;
  }

  /* 手动路径：「嗅探一次」按钮 / 桥接 xzSniff —— 立刻查、立刻回报，
     不走节流、不等二次确认（玩家自己点的，就是要立刻知道结果）。 */
  function sniff(force) {
    if (!S.settings) loadSettings();
    if (!S.settings.sniffer) { clearMissingFlag(); return true; }
    _sniffArmed = true;      /* 玩家主动查过 → 顺手武装轮询（万一某个酒馆版本不发那批事件） */
    var idx = latestAiIndex();
    if (idx < 0) { clearMissingFlag(); return true; }
    var chat = chatArray();
    var txt = msgText(chat[idx]);
    var problems = checkVarFormat(txt);
    var hasMissing = (problems.length > 0);
    var missingKey = idx + '::' + problems.slice().sort().join('|');

    S.lastMissing = hasMissing;
    S.missingList = problems;
    if (missingKey !== _lastReportedMissingKey) { _lastReportedMissingKey = missingKey; }
    try { notifyStatus(); } catch (eNo) {}

    if (hasMissing) {
      /* 手动查过＝这一楼已提示过，轮询不再重复弹同一楼 */
      _sniffedKey = 'p' + idx; _pendingKey = ''; _pendingAt = 0;
      notifyIssue(problems);
    } else {
      _sniffedKey = ''; _pendingKey = ''; _pendingAt = 0;
      if (S.hadMissingAlert) toast('✓【天元一界】状态变量已完整就绪。', 'success');
    }
    S.hadMissingAlert = hasMissing;

    if (hasMissing && force && S.settings.autoRepair && !S.running) {
      if (S.pendingTimer) clearTimeout(S.pendingTimer);
      S.pendingTimer = setTimeout(function () { S.pendingTimer = null; runComplete('fast'); }, 800);
    }
    return !hasMissing;
  }

  /* ══════════════════ 十三、配置存取 ══════════════════ */
  /* ★ v389：模型列表落盘 / 读回（见 KEY_MODELS 处的说明）。
     读回失败一律当「没有」，绝不让一个坏 JSON 把整个面板带崩。 */
  function saveModels(list) {
    try { store(KEY_MODELS, JSON.stringify(list || [])); } catch (e) {}
  }
  function loadModels() {
    try {
      var raw = store(KEY_MODELS);
      if (!raw) return null;
      var got = JSON.parse(raw);
      return (Array.isArray(got) && got.length) ? got : null;
    } catch (e) { return null; }
  }
  function loadSettings() {
    var raw = store(KEY_SETTINGS);
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (raw) {
      try {
        var got = JSON.parse(raw);
        for (var k2 in got) if (k2 in out) out[k2] = got[k2];
      } catch (e) {}
    }
    /* ★★★ v446：**强制迁移** —— 老存档里 tickerAuto 存的是 true（v432 的默认值），
       光改 DEFAULTS 对已经玩过的人一点用都没有：他们的 localStorage 里躺着那个 true。
       而这一项的语义已经从「自动刷新」变成「玩家自己按」，true 也不再有任何自动行为
       （maybeTicker 整段已删），所以这里直接抹成 false，与界面上那个开关的显示一致。
       ⚠ 别写成「只在没值时给 false」—— 那就等于老存档永远停在 true。 */
    out.tickerAuto = false;
    S.settings = out;
    return out;
  }
  function saveSettings() {
    try { store(KEY_SETTINGS, JSON.stringify(S.settings)); } catch (e) {}
  }

  /* ══════════════════ 十四、UI：状态栏按钮的状态源（悬浮球已废） ══════════════════ */
  /* 状态栏顶栏一个常驻按钮（走状态栏那套 document 级点击委派，重绘也不丢），
     本脚本只负责回答「按钮上写什么字、什么颜色」。 */
  function statusInfo() {
    /* ★ v3 用户口径：**格式正常＝绿色 ✅；异常＝红色 ❌**（红点在，直到修好）。
       另：running 琥珀 ↻ / 补算失败红 误 / 总开关关灰 关。 */
    var label = '✅', color = '#10b981', title = '外置变量补全：变量块格式正常，点一下打开面板';
    if (S.running) {
      label = '↻'; color = '#f59e0b';
      title = '正在补算…' + (S.statusText || '');
    } else if (S.status === 'bad') {
      label = '误'; color = '#ef4444';
      title = '上次补算失败：' + (S.statusText || '');
    } else if (S.lastMissing) {
      label = '❌'; color = '#ef4444';
      title = (S.missingList && S.missingList.length)
        ? ('变量块格式异常：' + S.missingList.join('、') + '，点开修复')
        : '最新一楼没有合规的 <UpdateVariable>，点开补一下';
    } else if (!S.settings || !S.settings.enabled) {
      label = '关'; color = '#7e7769';
      title = '外置变量补全总开关是关的，点开面板打开';
    } else if (S.status === 'ok') {
      label = '✅'; color = '#10b981';
      title = '变量块格式正常（上次补算成功：' + (S.statusText || '') + '）';
    }
    return { ok: true, label: label, color: color, title: title, status: S.status, missing: !!S.lastMissing, missingList: S.missingList || [] };
  }

  /* 桥给核心/界面脚本用（它们拿这个开面板、取状态） */
  function bridgeOpen() { openPanel(); return true; }
  function bridgeToggle() { togglePanel(); return true; }

  /* 就地局部刷新面板状态（绝不能整体替换 box.innerHTML，否则会销毁焦点并关闭输入框） */
  function updatePanelStatusInPlace() {
    if (!S.panel) return;
    try {
      var stEl = S.panel.querySelector('#xz-varc-status-val');
      if (stEl) {
        stEl.textContent = S.statusText || '待机';
        stEl.style.color = (S.status === 'bad' ? '#ef4444' : (S.status === 'ok' ? '#10b981' : (S.running ? '#f59e0b' : '#7fd2c1')));
      }
      var tipEl = S.panel.querySelector('#xz-varc-missing-tip');
      if (tipEl) {
        if (S.lastMissing) {
          tipEl.style.display = 'block';
          tipEl.textContent = '⚠ ' + (S.missingList && S.missingList.length ? ('变量块格式异常：' + S.missingList.join('、')) : '最新一楼没有合规的 <UpdateVariable>，点下面补一下。');
        } else {
          tipEl.style.display = 'none';
        }
      }
    } catch (e) {}
  }

  /* 状态变了：只更新面板局部状态文本和向外广播，绝不整块重绘 DOM 导致输入框关闭 */
  function notifyStatus() {
    try {
      if (S.panel) updatePanelStatusInPlace();
    } catch (e0) {}
    try {
      var d = doc();
      if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        d.dispatchEvent(new CustomEvent('xz-var-complete-status', { detail: statusInfo() }));
      }
    } catch (e1) {}
  }

  /* ══════════════════ 十五、UI：设置面板 ══════════════════ */
  /* 挂到「宿主窗口」而不是自己这个 iframe：
     优先找带 #chat 的真酒馆文档，退回最外层有 body 的那个。
     然后按 visualViewport 算成像素铺满，内联 !important 压过宿主与主题
     （跟 05 的状态/立绘浮层是同一套几何，手机上才不会只露一条、关闭按钮跑出屏幕）。 */
  function hostWindow() {
    var list = windows(), i, w;
    for (i = 0; i < list.length; i++) {
      try {
        w = list[i];
        if (w.document && w.document.getElementById && w.document.getElementById('chat')) return w;
      } catch (e) {}
    }
    for (i = list.length - 1; i >= 0; i--) {
      try { w = list[i]; if (w.document && w.document.body) return w; } catch (e2) {}
    }
    return (typeof window !== 'undefined') ? window : null;
  }
  function mountPanel(win, ov) {
    if (!win || !ov) return;
    var d = win.document;
    var vw = 0, vh = 0, top = 0, left = 0;
    try {
      var vv = win.visualViewport;
      if (vv && vv.height) { vh = vv.height; vw = vv.width; top = vv.offsetTop || 0; left = vv.offsetLeft || 0; }
    } catch (eV) {}
    if (!vh) { try { vh = win.innerHeight || 0; } catch (e1) {} }
    if (!vw) { try { vw = win.innerWidth || 0; } catch (e2) {} }
    if (!vh) vh = 800;
    if (!vw) vw = 400;
    ov.style.cssText = 'position:fixed !important;top:' + top + 'px !important;left:' + left + 'px !important;' +
      'width:' + vw + 'px !important;height:' + vh + 'px !important;right:auto !important;bottom:auto !important;' +
      'margin:0 !important;z-index:2147483647 !important;background:rgba(0,0,0,.66);' +
      'display:flex !important;align-items:flex-end;justify-content:center;padding:10px;box-sizing:border-box;' +
      'overflow:hidden;-webkit-tap-highlight-color:transparent;';
  }
  function togglePanel() { if (S.panel) closePanel(); else openPanel(); }
  function closePanel() {
    if (S.panel && S.panel.parentNode) S.panel.parentNode.removeChild(S.panel);
    S.panel = null;
  }
  function openPanel() {
    var win = hostWindow();
    var d = win && win.document;
    if (!d || !d.body) return;
    closePanel();
    if (!S.settings) loadSettings();
    if (!S.history.length) S.history = loadHistory();
    var ov = d.createElement('div');
    ov.id = 'xz-varc-overlay';
    mountPanel(win, ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closePanel(); });
    // 阻止内部事件冒泡到宿主 document，避免被外部捕获监听器误拦截或触发失焦
    ov.addEventListener('pointerdown', function (e) { if (e.target !== ov) e.stopPropagation(); });
    d.body.appendChild(ov);
    S.panel = ov;
    renderPanel();
    if (!S.wbCache) loadWorldbook().then(function () { if (S.panel) renderPanel(); });
  }

  function renderPanel() {
    if (!S.panel) return;
    // 仅当用户正在文本框打字时保护焦点；单选框、复选框、按钮等操作必须立即重绘面板！
    try {
      var actEl = (hostWindow()?.document || document).activeElement;
      if (actEl && S.panel.contains(actEl)) {
        var tag = actEl.tagName;
        var isTyping = (tag === 'TEXTAREA') || (tag === 'INPUT' && /^(text|password|number|search|url)$/i.test(actEl.type));
        if (isTyping) {
          updatePanelStatusInPlace();
          return;
        }
      }
    } catch (eAct) {}

    if (!S.settings) loadSettings();
    var set = S.settings;
    var wb = S.wbCache;
    var wbInfo = wb
      ? ('已读 ' + wb.count + ' 条｜规则 ' + (wb.rules ? '✔' : '✘') + '｜格式 ' + (wb.format.length ? ('✔' + wb.format.length) : (wb.fmtInRules ? '✔（在细则内）' : '✘')) + '｜速查 ' + (wb.roster ? '✔' : '✘'))
      : '读取中…';
    var npcStr = (S.lastNpcs && S.lastNpcs.length) ? S.lastNpcs.join('、') : '（未扫描）';
    var hist = S.history || [];

    var btn = 'background:rgba(255,255,255,.05);border:1px solid rgba(212,175,55,.3);color:#93c5fd;border-radius:6px;cursor:pointer;';
    var boxWidth = set.devMode ? 'max-width:880px;width:100%;' : 'max-width:560px;width:100%;';

    var html =
      '<div style="background:#0b1930;border:1.5px solid var(--xz-gold,#d4af37);border-radius:14px 14px 0 0;' + boxWidth +
      'max-height:94vh;overflow-y:auto;overscroll-behavior:contain;padding:16px 18px calc(16px + env(safe-area-inset-bottom,0px)) 18px;box-sizing:border-box;' +
      'color:#f1ede4;font-size:13.5px;line-height:1.55;box-shadow:0 -12px 40px rgba(0,0,0,.8);display:flex;flex-direction:column;gap:12px;">' +

      /* 头 */
      '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(212,175,55,.25);padding-bottom:9px;">' +
      '<div style="display:flex;align-items:baseline;gap:8px;">' +
      '<span style="font-weight:700;font-size:16px;letter-spacing:1px;">☯ 外置变量补全</span>' +
      '<span style="font-size:11px;color:#64748b;">v2.0 · 按存档隔离</span></div>' +
      '<button type="button" id="xz-varc-x" aria-label="关闭" style="flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:36px;min-height:32px;box-sizing:border-box;background:transparent;border:none;color:#93c5fd;font-size:22px;cursor:pointer;line-height:1;padding:0 4px;border-radius:6px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;">&times;</button>' +
      '</div>' +

      /* 状态 */
      '<div style="background:rgba(16,37,45,0.94);border:1px solid rgba(212,175,55,.28);border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:7px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="color:#93c5fd;font-weight:600;">状态</span>' +
      '<span id="xz-varc-status-val" style="font-size:12px;color:' + (S.status === 'bad' ? '#ef4444' : (S.status === 'ok' ? '#10b981' : (S.running ? '#f59e0b' : '#7fd2c1'))) + ';">' + esc(S.statusText) + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:#94a3b8;">存档键：<span style="color:#d4af37;">' + esc(S.chatKey || '—') + '</span></div>' +
      '<div style="font-size:12px;color:#94a3b8;">世界书：' + esc(wbInfo) + '</div>' +
      '<div style="font-size:12px;color:#94a3b8;">本轮命中人物：<span style="color:#d4af37;">' + esc(npcStr) + '</span></div>' +
      '<div id="xz-varc-missing-tip" style="font-size:12px;color:#f59e0b;' + (S.lastMissing ? '' : 'display:none;') + '">⚠ ' + (S.missingList && S.missingList.length ? ('变量块格式异常：' + esc(S.missingList.join('、'))) : '最新一楼没有合规的 &lt;UpdateVariable&gt;，点下面补一下。') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:3px;">' +
      '<button type="button" id="xz-varc-fast" style="flex:1;padding:10px 0;background:linear-gradient(135deg,#1d3a6f,#2b529a);border:1px solid #d4af37;border-radius:6px;color:#f1ede4;font-weight:700;cursor:pointer;">' + (S.running ? '⏳ 计算中…' : '⚡ 快速补算') + '</button>' +
      '<button type="button" id="xz-varc-deep" style="flex:1;padding:10px 0;background:linear-gradient(135deg,#3b1d6f,#5b2b9a);border:1px solid #a78bfa;border-radius:6px;color:#f1ede4;font-weight:700;cursor:pointer;">🧠 精细补算</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button type="button" id="xz-varc-pre" style="flex:1;padding:7px 0;' + btn + 'font-size:12px;">🔍 预览提示词</button>' +
      '<button type="button" id="xz-varc-sniff" style="flex:1;padding:7px 0;' + btn + 'font-size:12px;">🩺 嗅探一次</button>' +
      '<button type="button" id="xz-varc-wbrefresh" style="flex:1;padding:7px 0;' + btn + 'font-size:12px;">📚 重读世界书</button>' +
      '</div>' +
      /* ★★★ v510：整块时讯入口已删 ★★★
         用户 2026-10-31：「变量补全脚本中时讯相关的删了啊，都他妈没东西了」。
         「刷新坊间时讯（热议/闲杂）」那颗绿按钮 + 它下面那行状态（今天/事件 N 件/热议…）
         一起下架 —— 时讯的另一个入口（状态浮层里那三个按钮）v489 就已经删了，
         这颗是最后一处，删完界面上再也找不到时讯。
         ⚠ 底层函数（`tkPlan` / `tkRefresh` / `tickerPlanTip` …）**暂留**：
           它们还被「热议」那一支引用，整段摘要动 300+ 行，这一版先掐入口。 */
      '</div>' +

      /* 通道 */
      '<div style="background:rgba(16,37,45,0.92);border:1px solid rgba(212,175,55,.2);border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:9px;">' +
      '<div style="font-weight:700;color:#d4af37;">⚙ API 通道</div>' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;">' +
      '<input type="radio" name="xz-varc-mode" id="xz-varc-m-main"' + (set.apiMode !== 'custom' ? ' checked' : '') + ' style="accent-color:#d4af37;">' +
      '<span>酒馆主模型（不用填 Key，但主模型看到的是「补算」提示词）</span></label>' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;">' +
      '<input type="radio" name="xz-varc-mode" id="xz-varc-m-custom"' + (set.apiMode === 'custom' ? ' checked' : '') + ' style="accent-color:#d4af37;">' +
      '<span>另选专属接口（推荐：便宜快的小模型，别跟主模型抢上下文）</span></label>' +
      '<div style="display:' + (set.apiMode === 'custom' ? 'flex' : 'none') + ';flex-direction:column;gap:8px;" id="xz-varc-custom-box">' +
      '<div><div style="font-size:12px;color:#93c5fd;margin-bottom:3px;">地址 Base URL</div>' +
      '<input type="text" id="xz-varc-base" value="' + esc(set.base) + '" placeholder="https://api.openai.com/v1" style="width:100%;box-sizing:border-box;background:#06101e;border:1px solid rgba(212,175,55,.3);border-radius:6px;padding:7px 9px;color:#f1ede4;font-size:13px;"></div>' +
      '<div><div style="font-size:12px;color:#93c5fd;margin-bottom:3px;">API Key</div>' +
      '<input type="password" id="xz-varc-key" value="' + esc(set.key) + '" placeholder="sk-..." style="width:100%;box-sizing:border-box;background:#06101e;border:1px solid rgba(212,175,55,.3);border-radius:6px;padding:7px 9px;color:#f1ede4;font-size:13px;"></div>' +
      '<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">' +
      '<span style="font-size:12px;color:#93c5fd;">模型名</span>' +
      '<button type="button" id="xz-varc-pull" style="background:transparent;border:none;color:#d4af37;font-size:11px;cursor:pointer;text-decoration:underline;">📋 拉取模型</button></div>' +
      '<input type="text" id="xz-varc-model" value="' + esc(set.model) + '" placeholder="gpt-4o-mini / deepseek-chat" style="width:100%;box-sizing:border-box;background:#06101e;border:1px solid rgba(212,175,55,.3);border-radius:6px;padding:7px 9px;color:#f1ede4;font-size:13px;">' +
      (S.models && S.models.length ? ('<select id="xz-varc-sel" style="width:100%;margin-top:5px;box-sizing:border-box;background:#06101e;border:1px solid #7fd2c1;border-radius:6px;padding:6px;color:#7fd2c1;font-size:12px;">' +
        '<option value="">-- 选一个拉到的模型 --</option>' +
        S.models.map(function (m) { return '<option value="' + esc(m) + '"' + (m === set.model ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select>') : '') +
      '</div>' +
      '<div style="display:flex;gap:10px;">' +
      '<label style="flex:1;font-size:12px;color:#93c5fd;">温度<input type="number" id="xz-varc-temp" min="0" max="1" step="0.05" value="' + set.temperature + '" style="width:100%;box-sizing:border-box;margin-top:3px;background:#06101e;border:1px solid rgba(212,175,55,.3);border-radius:6px;padding:6px;color:#f1ede4;"></label>' +
      '<label style="flex:1;font-size:12px;color:#93c5fd;">输出上限 Tokens<input type="number" id="xz-varc-max" min="300" max="8000" step="100" value="' + set.maxTokens + '" style="width:100%;box-sizing:border-box;margin-top:3px;background:#06101e;border:1px solid rgba(212,175,55,.3);border-radius:6px;padding:6px;color:#f1ede4;"></label>' +
      '</div>' +
      '<button type="button" id="xz-varc-test" style="padding:7px 0;' + btn + 'font-size:12px;">测试接口连通性</button>' +
      '</div>' +
      '</div>' +

      /* 开关 */
      '<div style="display:flex;flex-direction:column;gap:8px;background:rgba(7,23,32,0.9);border:1px solid rgba(212,175,55,.15);border-radius:10px;padding:10px 13px;">' +
      sw('xz-varc-c-sniffer', set.sniffer, '实时嗅探：最新一楼缺变量块就把状态栏按钮变黄提醒') +
      sw('xz-varc-c-auto', set.auto, '生成完自动嗅探（只嗅探，不自动补）') +
      sw('xz-varc-c-autorepair', set.autoRepair, '嗅探到缺失就自动补（费 token，慎重）') +
      sw('xz-varc-c-tickerauto', set.tickerAuto !== false, '时讯自动刷新：事件换了 / 满 3 天，自动更新热议与闲杂事件') +
      sw('xz-varc-c-analysis', set.wantAnalysis, '要求 AI 输出 <Analysis>（变量细则本来就要）') +
      sw('xz-varc-c-dev', set.devMode, '开发者模式：摊开提示词与原始返回') +
      '</div>' +

      /* 开发者区（加大窗口至 ≥ 60vh，支持垂直拖拽拉伸与完整滚动，字号不压扁） */
      (set.devMode ? (
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-weight:700;color:#60a5fa;font-size:13px;">🛠 开发者调试区（高视口 · 支持拖拽拉高）</span>' +
        '<span style="font-size:11px;color:#64748b;">拖拽右下角可继续拉高</span>' +
        '</div>' +
        '<div id="xz-varc-dev-box" style="background:#06101e;border:1.5px solid #2563eb;border-radius:10px;padding:14px;min-height:60vh;max-height:78vh;height:60vh;resize:vertical;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.6;color:#93c5fd;white-space:pre-wrap;box-sizing:border-box;">' +
        '<div style="color:#fbbf24;font-weight:700;border-bottom:1px solid rgba(251,191,36,.25);padding-bottom:4px;margin-bottom:8px;">【1. System / 规则 + 格式要求】</div>' +
        esc(S.lastSystem || '（还没构建过，点上方「🔍 预览提示词」）') + '\n\n' +
        '<div style="color:#7fd2c1;font-weight:700;border-bottom:1px solid rgba(213,180,121,0.28);padding-bottom:4px;margin-bottom:8px;margin-top:14px;">【2. User / 当前局面 + 人物速查 + 楼层正文】</div>' +
        esc(S.lastPrompt || '（同上）') + '\n\n' +
        '<div style="color:#a78bfa;font-weight:700;border-bottom:1px solid rgba(167,139,250,.25);padding-bottom:4px;margin-bottom:8px;margin-top:14px;">【3. 模型原始返回结果】</div>' +
        esc(S.lastRaw || '（还没有返回）') +
        '</div></div>'
      ) : '') +

      /* 历史 */
      (hist.length ? (
        '<div style="border-top:1px solid rgba(212,175,55,.2);padding-top:8px;">' +
        '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">本存档最近 ' + hist.length + ' 次：</div>' +
        hist.map(function (h) {
          var ok = h.status === 'ok';
          return '<div style="font-size:11px;padding:3px 6px;background:rgba(255,255,255,.03);border-radius:4px;margin-bottom:3px;display:flex;justify-content:space-between;gap:8px;color:' + (ok ? '#10b981' : '#ef4444') + ';">' +
            '<span>' + (ok ? '✓' : '✘') + ' ' + (h.ms ? (h.ms / 1000).toFixed(1) + 's' : '') + ' · ' + (h.n || 0) + ' 条' + (h.npcs && h.npcs.length ? ' · ' + h.npcs.join(',') : '') + '</span>' +
            '<span style="color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;">' + esc(h.summary || '') + '</span></div>';
        }).join('') +
        '</div>'
      ) : '') +

      /* 底部 */
      '<div style="display:flex;gap:9px;">' +
      '<button type="button" id="xz-varc-save" style="flex:1;padding:9px 0;background:rgba(212,175,55,.16);border:1.5px solid var(--xz-gold,#d4af37);color:var(--xz-gold,#d4af37);border-radius:6px;font-weight:700;cursor:pointer;">💾 保存设置</button>' +
      '<button type="button" id="xz-varc-close" style="flex:1;padding:9px 0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);color:#94a3b8;border-radius:6px;cursor:pointer;">✕ 阅毕收起</button>' +
      '</div></div>';

    S.panel.innerHTML = html;

    function sw(id, checked, label) {
      return '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;">' +
        '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + ' style="accent-color:#d4af37;">' +
        '<span>' + label + '</span></label>';
    }

    function on(id, ev, fn) {
      var el = S.panel.querySelector('#' + id);
      if (el) el.addEventListener(ev, fn);
    }
    function chk(id, key, after) {
      on(id, 'change', function () {
        var el = S.panel.querySelector('#' + id);
        S.settings[key] = !!(el && el.checked);
        saveSettings();
        if (after) after();
      });
    }

    // 实时同步输入框内容到 S.settings，确保任何时刻不丢失玩家输入
    ['xz-varc-base', 'xz-varc-key', 'xz-varc-model', 'xz-varc-temp', 'xz-varc-max'].forEach(function (id) {
      on(id, 'input', function () { pullInputs(); });
    });

    on('xz-varc-x', 'click', closePanel);
    on('xz-varc-close', 'click', closePanel);
    on('xz-varc-save', 'click', function () {
      pullInputs(); saveSettings(); toast('✓ 设置已保存', 'success'); renderPanel();
    });
    on('xz-varc-fast', 'click', function () { pullInputs(); saveSettings(); runComplete('fast'); });
    on('xz-varc-deep', 'click', function () { pullInputs(); saveSettings(); runComplete('deep'); });
    /* ★ v510：`#xz-varc-ticker` 的绑定已删 —— 那颗按钮下架了（用户：「时讯相关的删了啊」）。 */
    on('xz-varc-sniff', 'click', function () {
      var ok = sniff(true);
      toast(ok ? '✓ 最新一楼变量块完整' : '⚠ 最新一楼缺变量块', ok ? 'success' : 'error');
      renderPanel();
    });
    on('xz-varc-wbrefresh', 'click', function () {
      loadWorldbook(true).then(function (wb) {
        toast('✓ 世界书已重读：规则 ' + (wb.rules ? '有' : '无') + '｜格式 ' + (wb.format.length ? (wb.format.length + ' 条') : (wb.fmtInRules ? '在细则内' : '无')) + '｜速查 ' + (wb.roster ? '有' : '无'), wb.rules ? 'success' : 'error');
        renderPanel();
      });
    });
    on('xz-varc-pre', 'click', function () {
      pullInputs();
      var idx = latestAiIndex();
      var chat = chatArray();
      if (idx < 0) { toast('没有可预览的楼层', 'error'); return; }
      loadWorldbook().then(function () {
        var sd = readState();
        var ui = latestUserIndexBefore(idx);
        var built = buildPrompt('fast', sd, {
          ai: stripVarBlocks(msgText(chat[idx])),
          user: ui >= 0 ? stripVarBlocks(msgText(chat[ui])) : ''
        }, '');
        S.lastSystem = built.system; S.lastPrompt = built.user;
        S.settings.devMode = true; saveSettings(); renderPanel();
        toast('已构建提示词并摊开（命中 ' + built.npcs.length + ' 人）', 'success');
      });
    });
    on('xz-varc-pull', 'click', function () {
      pullInputs();
      toast('正在拉模型列表…', 'info');
      fetchModels().then(function (l) {
        toast('✓ 拉到 ' + l.length + ' 个模型' + (S.lastModelVia ? '（走 ' + S.lastModelVia + '）' : ''), 'success');
        renderPanel();
      })
        .catch(function (e) {
          /* ★ v337：拉取失败**不再只是弹一句话就完事**。
             若是跨域被拦且我们能给出兜底模型，就把面板重绘一次，
             让那串模型名真的出现在下拉框里 —— 光在 toast 里说"你去手填"，等于没说。 */
          toast('拉取失败：' + e.message, 'error');
          if (e && e.fallback && e.fallback.length) renderPanel();
        });
    });
    on('xz-varc-sel', 'change', function () {
      var el = S.panel.querySelector('#xz-varc-sel');
      if (el && el.value) {
        S.settings.model = el.value;
        var mi = S.panel.querySelector('#xz-varc-model');
        if (mi) mi.value = el.value;
        saveSettings();
      }
    });
    on('xz-varc-test', 'click', function () {
      pullInputs();
      /* ★ v389：把**真正要发出去的**地址与模型名一起报出来。
         原来只说「正在测试…」⇒ 明明会自动把 gpt-4o-mini 换成豆包的模型名，
         玩家却完全看不见，出问题只能猜。测不通的时候尤其需要这两项。 */
      var _c = apiConfig();
      toast('正在测试…（模型 ' + _c.model + '）', 'info');
      executeApiCall([{ role: 'user', content: '回复 PONG 即可' }], 32)
        .then(function (r) {
          toast('✓ 接口通（' + apiConfig().model + '）：' + String(r).slice(0, 24), 'success');
        })
        .catch(function (e) {
          toast('✘ ' + e.message + '｜实际用了模型 ' + apiConfig().model + '、地址 ' + apiConfig().endpoint, 'error');
        });
    });
    function mode(fn) { on('xz-varc-m-main', 'change', fn); on('xz-varc-m-custom', 'change', fn); }
    mode(function () {
      var main = S.panel.querySelector('#xz-varc-m-main');
      S.settings.apiMode = (main && main.checked) ? 'main' : 'custom';
      saveSettings();
      var cbox = S.panel.querySelector('#xz-varc-custom-box');
      if (cbox) cbox.style.display = (S.settings.apiMode === 'custom' ? 'flex' : 'none');
      renderPanel();
    });
    chk('xz-varc-c-sniffer', 'sniffer', function () { sniff(); });
    chk('xz-varc-c-auto', 'auto');
    chk('xz-varc-c-autorepair', 'autoRepair');
    chk('xz-varc-c-tickerauto', 'tickerAuto');
    chk('xz-varc-c-analysis', 'wantAnalysis');
    chk('xz-varc-c-dev', 'devMode', renderPanel);
  }

  function pullInputs() {
    if (!S.panel || !S.settings) return;
    var g = function (id) { var el = S.panel.querySelector('#' + id); return el ? el.value : null; };
    var v;
    v = g('xz-varc-base'); if (v !== null) S.settings.base = String(v).trim();
    v = g('xz-varc-key'); if (v !== null) S.settings.key = String(v).trim();
    v = g('xz-varc-model'); if (v !== null) S.settings.model = String(v).trim() || DEFAULTS.model;
    v = g('xz-varc-temp'); if (v !== null) S.settings.temperature = clamp(v, 0, 1);
    v = g('xz-varc-max'); if (v !== null) S.settings.maxTokens = clamp(v, 300, 8000);
    var main = S.panel.querySelector('#xz-varc-m-main');
    if (main) S.settings.apiMode = main.checked ? 'main' : 'custom';
    saveSettings();
  }

  /* ══════════════════ 十六、事件挂载 ══════════════════ */
  function setupEvents() {
    /* ★ v76：武装嗅探 —— 本会话观察到「在生成 / 生成结束」才算，防止刚载页就拿历史楼层误报 */
    function armSniff() { _sniffArmed = true; }
    /* 快速通道：跳过节流立刻补查一次（生成结束 / 收到回复时，正文已定稿） */
    function fastSniff(force) {
      _sniffArmed = true;
      _pollAt = 0;
      try { pollSniff(force === true); } catch (eP) {}
    }
    /* 每个事件各自 try：某个事件名在当前酒馆版本不存在时，不许带崩后面所有注册 */
    function onEvt(name, fn) {
      try { if (name && typeof eventOn === 'function') eventOn(name, fn); } catch (e) {}
    }

    /* 换存档：立刻冷启动（事件 + 轮询双保险；有些酒馆版本不发 chat_id_changed） */
    try {
      if (typeof eventOn === 'function' && typeof tavern_events !== 'undefined') {
        var EV = tavern_events;
        onEvt(EV.CHAT_CHANGED, function () { watchChatSwitch(); });
        /* 新一轮开始 → 武装；并把上一楼的待确认状态清掉 */
        onEvt(EV.GENERATION_STARTED || 'GENERATION_STARTED', function () {
          armSniff(); _pendingKey = ''; _pendingAt = 0;
        });
        /* 生成结束 → 立刻补查一次（不必等下一轮 2 秒轮询） */
        onEvt(EV.GENERATION_ENDED || 'GENERATION_ENDED', function () { fastSniff(true); });
        onEvt(EV.GENERATION_STOPPED || 'GENERATION_STOPPED', function () { fastSniff(true); });
        /* 有些酒馆版本不发上面两个，靠「收到回复」兜底 */
        onEvt(EV.MESSAGE_RECEIVED || 'MESSAGE_RECEIVED', function (msgId) {
          try {
            var ctx = getContext();
            var ch = ctx && ctx.chat;
            if (ch && ch.length) {
              var m = (typeof msgId === 'number' && ch[msgId]) ? ch[msgId] : ch[ch.length - 1];
              if (m && m.is_user) return;      /* 自己刚发出去的那条不算「收到回复」 */
            }
          } catch (eMsg) {}
          fastSniff(true);
          /* ★ v446：这里原来还有一句 maybeTicker()（自动刷时讯）。已删 —— 见该函数位置的长注释。 */
        });
        /* 流式期间会反复触发 → 只武装，不查（此刻正文还是半截，查必误判） */
        onEvt(EV.CHARACTER_MESSAGE_RENDERED || 'CHARACTER_MESSAGE_RENDERED', function () { armSniff(); });
        onEvt(EV.MESSAGE_UPDATED || 'MESSAGE_UPDATED', function () { armSniff(); });
        onEvt(EV.WORLDINFO_UPDATED || 'WORLDINFO_UPDATED', function () { S.wbCache = null; });
      }
    } catch (eE) {}

    /* ★ v76（抄《同层版·春日狂想曲》v97）：嗅探时机 = 「**每 2 秒轮询一次**」。
       不看是谁触发的：点推进 / 切聊天 / 翻历史楼层 / swipe 换回复 /
       重新生成 / 自动续写 / 中途打断，全都会查。
       唯一抑制条件 = 正在生成中（正文还在流、MVU 还没落库）—— 此刻查必误报。
       入口：
         ① 心跳每 700ms 调 pollSniff()，函数内部按 2 秒节流（主路）；
         ② GENERATION_ENDED / STOPPED / MESSAGE_RECEIVED → fastSniff() 立刻补查一次；
         ③ 玩家手动点状态栏「🩺 变量补全」→ 只有这里才会弹面板。 */
    setInterval(function () {
      watchChatSwitch();
      try { pollSniff(false); } catch (ePoll) {}
    }, 700);

    /* 状态栏的按钮在另一个 iframe 里，跨窗调不到接口时靠这个广播兜底 */
    try {
      var d = doc();
      if (d && typeof d.addEventListener === 'function') {
        if (!d.__xzVarCompleteBs) {
          d.__xzVarCompleteBs = true;
          d.addEventListener('xz-var-complete-open', function () { openPanel(); }, false);
          d.addEventListener('xz-var-complete-toggle', function () { togglePanel(); }, false);
          /* ★ v439：「目前事件」页那颗「刷新当前热点」的兜底通道。
             正常情况走 __xzVarComplete.ticker() 直接调；跨窗被隔离时才落到这里。
             仍然只调 runTicker(true) 这一个实现 —— 不在这里重写一遍拉取逻辑。 */
          d.addEventListener('xz-ticker-run', function () { try { runTicker(true); } catch (eTR) {} }, false);
        }
      }
    } catch (eB) {}

    /* 斜杠指令：/xz补 与 /xz补全 */
    try {
      var s = st();
      if (s && s.SlashCommandParser && typeof s.SlashCommandParser.addCommand === 'function') {
        s.SlashCommandParser.addCommand('xz补', function () { runComplete('fast'); return '已触发外置变量补算（快速）'; },
          [], '外置 AI 给最新一楼补 <UpdateVariable>（快速）');
        s.SlashCommandParser.addCommand('xz补全', function () { runComplete('deep'); return '已触发外置变量补算（精细）'; },
          [], '外置 AI 给最新一楼补 <UpdateVariable>（精细，带上下文）');
      }
    } catch (eC) {}
  }

  /* 把接口挂到本窗 / 父窗 / 顶层窗：状态栏脚本与斗法器各自跑在 iframe 里，任意一层都要叫得到 */
  function exposeBridge() {
    var api = {
      open: bridgeOpen,
      toggle: bridgeToggle,
      close: closePanel,
      status: statusInfo,
      run: runComplete,
      /* ★★★ v439：把时讯专线也抛出去 —— 原来它**只有 08 自己那块面板能点**，
         而 `runTicker` 是个内部 function 声明，压根没挂到 window 上。
         后果：'目前事件' 页（这是玩家真在看热议/闲杂的地方）一个拉取入口都没有，
         玩家必须先进「🩺 变量补全」面板才知道有这么个功能。
         用户 2026-10-28：「没见目前事件里面的 api 拉取相关按钮啊，搞一下。」
         ⇒ 参数 force=true 是**故意的**：玩家手点就是要立刻看到新内容，
           不许再走 maybeTicker 那套「没到点就静默跳过」，点了没反应比没按钮更坏。 */
      /* ★ v489：时讯专线**已下架**（用户 2026-10-31：「算了，咨询球下架吧，
         保存到某个目录里，正式下架，相关条目也下架，也就是至此，再也没有什么当前事件了，
         而是玩家只能自己去事件总表里看激活了啥」）。
         ⇒ 入口保留成已退役形状而不是直接删键：外面（旧存档的按钮 / 闸 / 探针）
           可能还捏着这个名字，直接删会变成 TypeError，比点了说不支持更难查。
         ⚠ 真正的守卫在 工具/_v489_info_ball_retired.mjs（它会扫 xzTickerHotUI 的写入）。 */
      ticker: function () {
        return Promise.resolve({ skipped: 'retired', why: '资讯球与时讯已于 v489 下架' });
      },
      tickerPlan: function () { return '时讯已下架（v489）'; },
      sniff: sniff,
      pollSniff: pollSniff,
      resetSniff: resetSniffState,
      state: function () { return S; },
      chatId: chatId,
      resetForNewChat: resetForNewChat,
      loadWorldbook: loadWorldbook,
      scanNpcs: scanNpcs,
      buildPrompt: function (mode) {
        var idx = latestAiIndex();
        var chat = chatArray();
        var ui = idx >= 0 ? latestUserIndexBefore(idx) : -1;
        return buildPrompt(mode || 'fast', readState(), {
          ai: idx >= 0 ? stripVarBlocks(msgText(chat[idx])) : '',
          user: ui >= 0 ? stripVarBlocks(msgText(chat[ui])) : ''
        }, '');
      }
    };
    window.__xzVarComplete = api;
    window.xzOpenVarComplete = bridgeOpen;         /* 状态栏按钮点的就是这个 */
    window.xzVarCompleteStatus = statusInfo;
    window.xzSniff = sniff;
    var chain = [];
    try { chain.push(window.parent); } catch (e0) {}
    try { chain.push(window.top); } catch (e1) {}
    for (var i = 0; i < chain.length; i++) {
      try {
        if (!chain[i] || chain[i] === window) continue;
        chain[i].__xzVarComplete = api;
        chain[i].xzOpenVarComplete = bridgeOpen;
        chain[i].xzVarCompleteStatus = statusInfo;
        chain[i].xzSniff = sniff;
      } catch (e2) {}
    }
    /* 顶层页面里的同源 iframe（状态栏就在那儿）也扫一遍 */
    try {
      var t = window.top || window;
      var frames = t.document.querySelectorAll('iframe');
      for (var j = 0; j < frames.length; j++) {
        try {
          var fw = frames[j].contentWindow;
          if (fw && fw !== window) {
            fw.xzOpenVarComplete = bridgeOpen;
            fw.xzVarCompleteStatus = statusInfo;
            fw.xzSniff = sniff;
          }
        } catch (e3) {}
      }
    } catch (e4) {}
  }

  /* ══════════════════ 十七、初始化 ══════════════════ */
  function init() {
    loadSettings();
    S.chatKey = chatId();
    _chatKeySeen = S.chatKey;
    S.history = loadHistory();
    /* ★ v389：把上次拉到的模型列表读回来 —— 不读的话，豆包玩家每次刷新页面
       都要再点一次「拉取模型」，而那个按钮只会再报一次 404。 */
    S.models = loadModels();
    exposeBridge();
    setupEvents();
    loadWorldbook().catch(function () {});
    /* ★ v76：初始化时**不武装嗅探**。心跳虽然从第 700ms 就开始跑 pollSniff，
       但 _sniffArmed 还是 false —— 不给「刚载页 / 刚切聊天」拿历史楼层误报的机会。
       等本会话观察到第一轮生成（GENERATION_STARTED / ENDED / 收到回复）才真正启用。 */
    console.log('[天元一界] 外置变量补全 v2.1 已就绪｜缓存按存档隔离：' + S.chatKey +
      '｜嗅探＝每 2 秒轮询（抄春日狂想曲 v97，只弹提示不弹面板）｜入口＝状态栏「🩺 变量补全」按钮');
  }

  /* 等 Mvu 就位再起（等不到也照样起，写完会走 insertOrAssignVariables 兜底） */
  function boot() {
    /* ★ v1.08：世界书补丁在启动后跑一次。
       ⚠ 延迟 6 秒：酒馆刚打开时 `world_info` 可能还没加载完，
         这时候 `updateWorldbookWith` 拿到的是一本**空书**，
         写回去就等于把整本书清了。等它稳定再动手。
       ⚠ 失败不阻断其它功能（补丁只是锦上添花，界面不能因此起不来）。 */
    if (WBP_AUTO) {
      setTimeout(function () {
        try { wbpApply(); } catch (e) {}
      }, 6000);
    }
    try {
      if (typeof waitGlobalInitialized === 'function') {
        waitGlobalInitialized('Mvu').then(init).catch(init);
        setTimeout(function () { if (!S.settings) init(); }, 3000);
      } else init();
    } catch (e) { init(); }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else setTimeout(boot, 300);
  }
})();
