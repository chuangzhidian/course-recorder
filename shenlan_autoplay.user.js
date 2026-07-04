// ==UserScript==
// @name         深蓝学院 视频自动连播（配合录屏无人值守）
// @namespace    wechat2docx.video
// @version      0.2.0
// @description  在深蓝学院课程页按顺序自动播放各视频课时：一节结束后自动切到下一节并开播，配合 OBS 等录屏工具实现整门课挂机录制。不下载/不解密，仅自动化你手动就能做的“点下一节+播放”。仅用于录制你已购/有权观看的内容。
// @author       wechat2docx
// @match        *://*.shenlanxueyuan.com/course/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 关键：脚本只在顶层课程页运行。播放器 iframe(.../activity_show) 也匹配本站，
  // 若不拦住会跑出第二份实例，互相抢状态、导致“播完不自动跳”。
  if (window.top !== window.self) return;

  // —————————————— 可调参数 ——————————————
  const BUFFER_MS = 4000;              // 一节结束后等几秒再切下一节（给录屏留干净的分段边界）
  const SAFETY_PAD_MS = 120 * 1000;    // 单节看守 = 视频时长 + 该余量；时长未知时用下面的兜底
  const SAFETY_FALLBACK_MS = 75 * 60 * 1000; // 时长未知时的单节最长看守（>最长课时即可）
  const NO_VIDEO_MS = 15 * 1000;       // 点开某节 N 秒内没出现视频 → 判为非视频(PDF/课件)，自动跳过
  const POLL_MS = 1000;

  const LS_STATE = 'sl_autoplay_state';       // {running, idx}
  const LS_TIMELINE = 'sl_autoplay_timeline'; // [{i,title,at}]  供录完后剪辑分段

  // —————————————— 状态存取（跨整页刷新保持）——————————————
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_STATE)) || {}; } catch (_) { return {}; } }
  function saveState(s) { localStorage.setItem(LS_STATE, JSON.stringify(s)); }
  function loadTimeline() { try { return JSON.parse(localStorage.getItem(LS_TIMELINE)) || []; } catch (_) { return []; } }
  function pushTimeline(rec) { const t = loadTimeline(); t.push(rec); localStorage.setItem(LS_TIMELINE, JSON.stringify(t)); }

  // —————————————— DOM 定位 ——————————————
  // 视频课时 = 目录里含【视频】的 li.task-item，按 DOM 顺序即课程顺序
  function lessons() {
    return [...document.querySelectorAll('li.task-item')].filter(li => /【视频】/.test(li.textContent));
  }
  function lessonTitle(li) {
    return (li ? li.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(未知)';
  }
  // 从元素 HTML 里抽取 /task/<id>/，用于把“当前正在放的课时”锚定到列表下标
  function taskIdOf(el) {
    const m = (el && el.outerHTML || '').match(/task\/(\d+)/);
    return m ? m[1] : null;
  }
  function currentTaskId() {
    const f = document.querySelector('#task-content-iframe');
    let m = f && (f.src || '').match(/task\/(\d+)/);
    if (m) return m[1];
    m = location.pathname.match(/task\/(\d+)/);
    return m ? m[1] : null;
  }
  // 定位当前下标：优先按 task id 精确锚定（防跑偏），失败再用存档 idx
  function currentIndex(list) {
    const id = currentTaskId();
    if (id) {
      const i = list.findIndex(li => taskIdOf(li) === id);
      if (i >= 0) return i;
    }
    const st = loadState();
    return (typeof st.idx === 'number') ? st.idx : -1;
  }
  // 取播放器 video（在同源 iframe #task-content-iframe 内）
  function getVideo() {
    const f = document.querySelector('#task-content-iframe');
    try {
      const d = f && f.contentDocument;
      if (d) { const v = d.querySelector('video'); if (v) return v; }
    } catch (_) { /* 万一跨域 */ }
    return document.querySelector('video') || null;
  }
  // 点击某一课时（触发加载该节视频）
  function clickLesson(li) {
    if (!li) { log('目标课时不存在，停止'); saveState({ running: false }); return; }
    const a = li.querySelector('a[href]');
    (a || li).click();
  }
  // 尝试开播：先 video.play()，被自动播放策略拦截则点播放器上的播放按钮/海报
  function ensurePlaying(v) {
    try {
      if (v.paused) {
        const p = v.play();
        if (p && p.catch) p.catch(() => tryClickPlay());
      }
    } catch (_) { tryClickPlay(); }
  }
  function tryClickPlay() {
    const f = document.querySelector('#task-content-iframe');
    try {
      const d = f && f.contentDocument;
      if (!d) return;
      const btn = d.querySelector(
        '.pv-poster,.pv-video-poster,.plv-poster,.prism-play-btn,.vjs-big-play-button,' +
        '[class*=play-btn],[class*=poster],[class*=start],[class*=play-icon]'
      );
      if (btn) btn.click();
      else { const v = d.querySelector('video'); if (v) v.click(); }
    } catch (_) {}
  }

  // —————————————— 主循环 ——————————————
  let curId = null;       // 当前正在处理的 task id
  let curSince = 0;       // 进入当前 task 的时间戳（用于“无视频超时跳过”）
  let curArmed = false;   // 当前节是否已挂好 ended 看守
  let advancingId = null; // 已对哪个 task 触发过“切下一节”，避免重复推进

  function advanceFrom(i, why) {
    if (advancingId === curId) return; // 本节只推进一次
    advancingId = curId;
    const list = lessons();
    const next = i + 1;
    if (next >= list.length) { log('✅ 全部课时已放完'); saveState({ running: false }); return; }
    saveState({ running: true, idx: next });
    log(`⏭ (${why}) ${BUFFER_MS / 1000}s 后切到第 ${next + 1} 节…`);
    setTimeout(() => clickLesson(lessons()[next]), BUFFER_MS);
  }

  function tick() {
    updateUI();
    const st = loadState();
    if (!st.running) return;

    const list = lessons();
    if (!list.length) return;
    const i = currentIndex(list);
    if (i < 0) return;

    const id = currentTaskId();
    if (id !== curId) {           // 切到了新的一节 → 重置本节看守
      curId = id; curSince = Date.now(); curArmed = false;
    }

    const v = getVideo();
    if (!v) {
      // 迟迟没有视频 → 这一节可能是 PDF/课件，自动跳过
      if (Date.now() - curSince > NO_VIDEO_MS) advanceFrom(i, '本节无视频·跳过');
      return;
    }
    ensurePlaying(v);             // 每个 tick 都保证在播（被暂停也会重试）
    if (curArmed) return;
    curArmed = true;

    const started = new Date().toLocaleString();
    log(`▶ 第 ${i + 1}/${list.length} 节开始：` + lessonTitle(list[i]));
    pushTimeline({ i: i + 1, title: lessonTitle(list[i]), at: started });

    v.addEventListener('ended', () => advanceFrom(i, '播放结束'), { once: true });
    const guard = (isFinite(v.duration) && v.duration > 0)
      ? v.duration * 1000 + SAFETY_PAD_MS
      : SAFETY_FALLBACK_MS;
    setTimeout(() => advanceFrom(i, '看守超时'), guard);
  }

  // —————————————— 控制面板 UI（建一次，之后只更新文字）——————————————
  let box, statusEl, curEl, logEl, bodyEl, collapsed = false;

  function mkBtn(text, bg) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = [
      'flex:1', 'margin:3px 3px 0 0', 'padding:7px 8px', 'border:0', 'border-radius:7px',
      'background:' + bg, 'color:#fff', 'font-weight:600', 'font-size:12px', 'cursor:pointer',
    ].join(';');
    return b;
  }

  function buildUI() {
    box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#fff', 'border:1px solid #e2e8f0', 'border-radius:12px',
      'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'padding:10px 12px', 'width:280px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px', 'color:#1a1a1a',
    ].join(';');

    // 顶栏：标题（可拖动） + 折叠按钮
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:move';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700';
    title.textContent = '🎬 深蓝自动连播';
    const toggle = document.createElement('button');
    toggle.textContent = '—';
    toggle.title = '折叠/展开（拖动标题可移动面板）';
    toggle.style.cssText = 'border:0;background:#f1f5f9;border-radius:6px;width:22px;height:22px;cursor:pointer;font-weight:700';
    toggle.onclick = () => { collapsed = !collapsed; bodyEl.style.display = collapsed ? 'none' : 'block'; toggle.textContent = collapsed ? '+' : '—'; };
    bar.appendChild(title); bar.appendChild(toggle); box.appendChild(bar);
    makeDraggable(bar, box);

    bodyEl = document.createElement('div');
    box.appendChild(bodyEl);

    statusEl = document.createElement('div'); statusEl.style.cssText = 'margin-top:4px;color:#64748b';
    curEl = document.createElement('div'); curEl.style.cssText = 'margin-top:2px;color:#94a3b8;font-size:11px';
    bodyEl.appendChild(statusEl); bodyEl.appendChild(curEl);

    const row1 = document.createElement('div'); row1.style.cssText = 'display:flex';
    const bStart = mkBtn('▶ 从第1节', '#07c160');
    const bHere = mkBtn('▶ 从当前节', '#2563eb');
    bStart.onclick = () => { localStorage.removeItem(LS_TIMELINE); resetRun(0); clickLesson(lessons()[0]); };
    bHere.onclick = () => { const j = Math.max(0, currentIndex(lessons())); resetRun(j); log('从当前节开始'); tick(); };
    row1.appendChild(bStart); row1.appendChild(bHere); bodyEl.appendChild(row1);

    const row2 = document.createElement('div'); row2.style.cssText = 'display:flex';
    const bStop = mkBtn('⏹ 停止', '#dc2626');
    const bNext = mkBtn('⏭ 手动下一节', '#64748b');
    const bCopy = mkBtn('📋 分段表', '#0f766e');
    bStop.onclick = () => { saveState({ running: false }); log('已停止'); updateUI(); };
    bNext.onclick = () => { const j = currentIndex(lessons()); if (j >= 0) { resetRun(j + 1); clickLesson(lessons()[j + 1]); } };
    bCopy.onclick = () => {
      const t = loadTimeline().map(r => `${r.i}\t${r.at}\t${r.title}`).join('\n');
      navigator.clipboard.writeText(t || '(空)').then(() => log('分段时间表已复制'));
    };
    row2.appendChild(bStop); row2.appendChild(bNext); row2.appendChild(bCopy); bodyEl.appendChild(row2);

    logEl = document.createElement('div');
    logEl.style.cssText = 'margin-top:8px;max-height:110px;overflow:auto;font-size:11px;color:#475569;white-space:pre-wrap;border-top:1px solid #eef2f7;padding-top:6px';
    bodyEl.appendChild(logEl);

    document.body.appendChild(box);
    updateUI();
  }

  // 重新开始/跳转前，清掉本轮看守状态
  function resetRun(idx) { saveState({ running: true, idx }); curId = null; curArmed = false; advancingId = null; updateUI(); }

  function makeDraggable(handle, target) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', e => {
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = target.getBoundingClientRect(); ox = r.left; oy = r.top;
      target.style.right = 'auto'; target.style.bottom = 'auto';
      target.style.left = ox + 'px'; target.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      target.style.left = (ox + e.clientX - sx) + 'px';
      target.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  function updateUI() {
    if (!box || !document.body.contains(box)) { buildUI(); return; }
    const st = loadState();
    const list = lessons();
    const i = currentIndex(list);
    statusEl.textContent = st.running
      ? `▶ 运行中 · 第 ${i + 1}/${list.length} 节`
      : `⏸ 待机 · 共 ${list.length} 个视频课时`;
    curEl.textContent = '当前：' + (i >= 0 ? lessonTitle(list[i]) : '未定位');
    if (logEl) logEl.textContent = (loadTimeline().slice(-6).map(r => `${r.i}. ${r.at} ${r.title}`).join('\n')) || '日志…';
  }

  function log(...a) {
    console.log('[SL-AUTO]', ...a);
    if (logEl) logEl.textContent = (logEl.textContent + '\n' + a.join(' ')).split('\n').slice(-8).join('\n');
  }

  // —————————————— 启动 ——————————————
  buildUI();
  setInterval(tick, POLL_MS);
})();
