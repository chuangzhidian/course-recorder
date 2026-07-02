// ==UserScript==
// @name         深蓝学院 视频自动连播（配合录屏无人值守）
// @namespace    wechat2docx.video
// @version      0.1.0
// @description  在深蓝学院课程页按顺序自动播放各视频课时：一节结束后自动切到下一节并开播，配合 OBS 等录屏工具实现整门课挂机录制。不下载/不解密，仅自动化你手动就能做的“点下一节+播放”。仅用于录制你已购/有权观看的内容。
// @author       wechat2docx
// @match        *://*.shenlanxueyuan.com/course/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // —————————————— 可调参数 ——————————————
  const BUFFER_MS = 4000;             // 一节结束后等几秒再切下一节（给录屏留干净的分段边界）
  const SAFETY_PAD_MS = 120 * 1000;   // 单节看守 = 视频时长 + 该余量；时长未知时用下面的兜底
  const SAFETY_FALLBACK_MS = 75 * 60 * 1000; // 时长未知时的单节最长看守（>最长课时即可）
  const POLL_MS = 1000;

  const LS_STATE = 'sl_autoplay_state';     // {running, idx}
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
  // 定位当前下标：优先按 task id 精确锚定（防止跑偏），失败再用存档的 idx
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
        '.pv-video-poster,.plv-poster,.prism-play-btn,.vjs-big-play-button,[class*=play-btn],[class*=poster],[class*=start]'
      );
      if (btn) btn.click();
      else { const v = d.querySelector('video'); if (v) v.click(); }
    } catch (_) {}
  }

  // —————————————— 主循环 ——————————————
  let armedFor = null; // 已为哪个 (taskId) 挂过 ended，避免重复挂

  function tick() {
    render();
    const st = loadState();
    if (!st.running) return;

    const list = lessons();
    if (!list.length) return;
    const i = currentIndex(list);
    if (i < 0) { log('暂时无法定位当前课时，等待页面就绪…'); return; }

    const v = getVideo();
    if (!v) return;              // 视频还没出来，下个 tick 再看
    ensurePlaying(v);

    const id = currentTaskId();
    if (armedFor === id) return; // 本节已挂好 ended
    armedFor = id;

    const started = new Date().toLocaleString();
    log(`▶ 第 ${i + 1}/${list.length} 节开始 [${started}]：` + lessonTitle(list[i]));
    pushTimeline({ i: i + 1, title: lessonTitle(list[i]), at: started });

    let done = false;
    const advance = (why) => {
      if (done) return; done = true;
      const next = i + 1;
      if (next >= list.length) { log('✅ 全部课时已放完'); saveState({ running: false }); render(); return; }
      saveState({ running: true, idx: next });
      log(`⏭ (${why}) ${BUFFER_MS / 1000}s 后切到第 ${next + 1} 节…`);
      setTimeout(() => clickLesson(lessons()[next]), BUFFER_MS);
    };

    v.addEventListener('ended', () => advance('播放结束'), { once: true });
    const guard = (isFinite(v.duration) && v.duration > 0)
      ? v.duration * 1000 + SAFETY_PAD_MS
      : SAFETY_FALLBACK_MS;
    setTimeout(() => { if (!done) advance('看守超时'); }, guard);
  }

  // —————————————— 控制面板 UI ——————————————
  let box = null, logEl = null;
  function ensureBox() {
    if (box && document.body.contains(box)) return;
    box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#fff', 'border:1px solid #e2e8f0', 'border-radius:12px',
      'box-shadow:0 6px 24px rgba(0,0,0,.18)', 'padding:11px 13px', 'width:280px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px', 'color:#1a1a1a',
    ].join(';');
    document.body.appendChild(box);
  }
  function mkBtn(text, bg) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = [
      'flex:1', 'margin:3px 3px 0 0', 'padding:7px 8px', 'border:0', 'border-radius:7px',
      'background:' + bg, 'color:#fff', 'font-weight:600', 'font-size:12px', 'cursor:pointer',
    ].join(';');
    return b;
  }
  function render() {
    ensureBox();
    const st = loadState();
    const list = lessons();
    const i = currentIndex(list);
    const status = st.running
      ? `▶ 运行中 · 第 ${i + 1}/${list.length} 节`
      : `⏸ 待机 · 共 ${list.length} 个视频课时`;

    box.innerHTML = '';
    const head = document.createElement('div');
    head.innerHTML = `<div style="font-weight:700">🎬 深蓝自动连播</div>
      <div style="margin-top:4px;color:#64748b">${status}</div>
      <div style="margin-top:2px;color:#94a3b8;font-size:11px">当前：${i >= 0 ? lessonTitle(list[i]) : '未定位'}</div>`;
    box.appendChild(head);

    const row1 = document.createElement('div'); row1.style.cssText = 'display:flex';
    const bStart = mkBtn('▶ 从第1节', '#07c160');
    const bHere = mkBtn('▶ 从当前节', '#2563eb');
    bStart.onclick = () => { localStorage.removeItem(LS_TIMELINE); saveState({ running: true, idx: 0 }); armedFor = null; clickLesson(lessons()[0]); render(); };
    bHere.onclick = () => { const j = Math.max(0, currentIndex(lessons())); saveState({ running: true, idx: j }); armedFor = null; log('从当前节开始'); tick(); render(); };
    row1.appendChild(bStart); row1.appendChild(bHere); box.appendChild(row1);

    const row2 = document.createElement('div'); row2.style.cssText = 'display:flex';
    const bStop = mkBtn('⏹ 停止', '#dc2626');
    const bNext = mkBtn('⏭ 手动下一节', '#64748b');
    const bCopy = mkBtn('📋 分段表', '#0f766e');
    bStop.onclick = () => { saveState({ running: false }); armedFor = null; log('已停止'); render(); };
    bNext.onclick = () => { const j = currentIndex(lessons()); if (j >= 0) { saveState({ running: true, idx: j + 1 }); armedFor = null; clickLesson(lessons()[j + 1]); } };
    bCopy.onclick = () => {
      const t = loadTimeline().map(r => `${r.i}\t${r.at}\t${r.title}`).join('\n');
      navigator.clipboard.writeText(t || '(空)').then(() => log('分段时间表已复制'));
    };
    row2.appendChild(bStop); row2.appendChild(bNext); row2.appendChild(bCopy); box.appendChild(row2);

    logEl = document.createElement('div');
    logEl.style.cssText = 'margin-top:8px;max-height:120px;overflow:auto;font-size:11px;color:#475569;white-space:pre-wrap;border-top:1px solid #eef2f7;padding-top:6px';
    logEl.textContent = (loadTimeline().slice(-6).map(r => `${r.i}. ${r.at} ${r.title}`).join('\n')) || '日志…';
    box.appendChild(logEl);
  }
  function appendLog(line) {
    if (logEl) { logEl.textContent = (logEl.textContent + '\n' + line).split('\n').slice(-8).join('\n'); }
  }
  function log(...a) { console.log('[SL-AUTO]', ...a); appendLog(a.join(' ')); }

  // —————————————— 启动 ——————————————
  render();
  setInterval(tick, POLL_MS);
})();
