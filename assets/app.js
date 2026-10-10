/* Margin — offline markdown reader. Vanilla JS, no build step. */
(function () {
'use strict';

var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
/* Shown in Library → Version. Bump alongside VERSION in sw.js so a stale deploy
   is visible on the device instead of having to be guessed at. */
var BUILD = '2026-08-25 · 3';

var reader = $('#reader'), railEl = $('#rail'), scrim = $('#scrim');
var railThumb = null;
var BAR = 52;

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function hashOf(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + '-' + str.length.toString(36);
}
function debounce(fn, ms) {
  var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
}
function fmtDate(t) {
  var d = new Date(t), h = d.getHours(), ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return d.getDate() + ' ' + d.toLocaleString(undefined, { month: 'long' }) + ' ' + d.getFullYear() +
    ' at ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
}
function fmtShort(t) {
  if (!t) return 'never opened';
  var diff = (Date.now() - t) / 864e5, d = new Date(t);
  var hm = (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() >= 12 ? 'pm' : 'am');
  if (diff < 1 && new Date().getDate() === d.getDate()) return 'today ' + hm;
  if (diff < 2) return 'yesterday ' + hm;
  return d.getDate() + ' ' + d.toLocaleString(undefined, { month: 'short' }) + ' ' + d.getFullYear();
}
function bytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function byteLen(s) {
  try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
}

var toastT;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2200);
}

/* ---------------- storage ---------------- */
var DB = {
  _p: null,
  open: function () {
    if (this._p) return this._p;
    this._p = new Promise(function (res, rej) {
      var r = indexedDB.open('margin', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return this._p;
  },
  run: function (store, mode, fn) {
    return this.open().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(store, mode), req;
        try { req = fn(tx.objectStore(store)); } catch (e) { rej(e); return; }
        tx.oncomplete = function () { res(req ? req.result : undefined); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  },
  get: function (s, k) { return this.run(s, 'readonly', function (o) { return o.get(k); }); },
  all: function (s) { return this.run(s, 'readonly', function (o) { return o.getAll(); }); },
  put: function (s, v, k) { return this.run(s, 'readwrite', function (o) { return o.put(v, k); }); },
  del: function (s, k) { return this.run(s, 'readwrite', function (o) { return o.delete(k); }); }
};

/* ---------------- settings ---------------- */
var DEFAULTS = {
  theme: 'auto', font: 'sans', size: 18, lh: 165, width: 38, sp: 0,
  justify: false, wrapCode: true, autoHide: true, rail: true,
  customSel: null,   // null = auto: on for touch screens, off for mouse
  resume: false,     // false = land on the file chooser instead of the last file
  lastDoc: null
};
var S = Object.assign({}, DEFAULTS);
try { Object.assign(S, JSON.parse(localStorage.getItem('margin.settings') || '{}')); } catch (e) {}
var saveSettings = debounce(function () {
  try { localStorage.setItem('margin.settings', JSON.stringify(S)); } catch (e) {}
}, 250);

function coarsePointer() {
  try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}
function csEnabled() {
  return S.customSel == null ? coarsePointer() : !!S.customSel;
}

function applySettings() {
  var r = document.documentElement;
  r.setAttribute('data-theme', S.theme);
  r.style.setProperty('--fs', S.size + 'px');
  r.style.setProperty('--lh', (S.lh / 100).toFixed(2));
  r.style.setProperty('--measure', S.width + 'rem');
  r.style.setProperty('--sp', (S.sp / 100).toFixed(3) + 'em');
  r.style.setProperty('--body', 'var(--f-' + S.font + ')');
  document.body.classList.toggle('justify', !!S.justify);
  document.body.classList.toggle('wrapcode', !!S.wrapCode);
  document.body.classList.toggle('norail', !S.rail);
  document.body.classList.toggle('cs', csEnabled());
  var mt = $('meta[name=theme-color]');
  if (mt) mt.content = getComputedStyle(document.body).backgroundColor;
  saveSettings();
}

/* ---------------- markdown pipeline ---------------- */
var fnDefs, fnOrder;

marked.use({
  gfm: true, breaks: false, pedantic: false,
  extensions: [
    {
      name: 'fnDef', level: 'block',
      start: function (src) { var m = /^\[\^/m.exec(src); return m ? m.index : undefined; },
      tokenizer: function (src) {
        var m = /^\[\^([^\]\n]+)\]:[ \t]*([^\n]*(?:\n(?![ \t]*(?:\n|\[\^))[^\n]*)*)\n?/.exec(src);
        if (!m) return;
        var body = m[2].replace(/\n[ \t]{0,4}/g, '\n').trim();
        return { type: 'fnDef', raw: m[0], fid: m[1], tokens: this.lexer.blockTokens(body + '\n') };
      },
      renderer: function (t) { fnDefs[t.fid] = this.parser.parse(t.tokens); return ''; }
    },
    {
      name: 'fnRef', level: 'inline',
      start: function (src) { var i = src.indexOf('[^'); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^\[\^([^\]\n]+)\]/.exec(src);
        if (!m) return;
        return { type: 'fnRef', raw: m[0], fid: m[1] };
      },
      renderer: function (t) {
        var i = fnOrder.indexOf(t.fid);
        if (i < 0) { fnOrder.push(t.fid); i = fnOrder.length - 1; }
        var k = esc(t.fid);
        return '<sup id="fnref-' + k + '"><a href="#fn-' + k + '">[' + (i + 1) + ']</a></sup>';
      }
    }
  ]
});

function splitFront(src) {
  if (!/^---[ \t]*\r?\n/.test(src)) return { fm: null, body: src };
  var m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fm: null, body: src };
  var out = [];
  m[1].split(/\r?\n/).forEach(function (line) {
    var k = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (k) out.push([k[1], k[2].replace(/^["']|["']$/g, '').trim()]);
  });
  return { fm: out, body: src.slice(m[0].length) };
}

var KW = ('function|return|const|let|var|if|else|for|while|class|import|export|from|new|this|async|await|try|catch|finally|' +
  'throw|switch|case|break|continue|default|typeof|instanceof|extends|super|yield|delete|in|of|do|static|' +
  'def|elif|lambda|pass|with|as|not|and|or|is|None|True|False|self|print|' +
  'public|private|protected|void|int|float|double|string|bool|boolean|char|long|struct|enum|interface|type|impl|fn|mut|' +
  'select|insert|update|delete|where|group|order|by|join|left|right|inner|values|table|null|true|false|' +
  'echo|local|then|fi|esac|done|elsif|end|module|require|package|func|defer|go|nil').split('|');
var KWSET = new RegExp('\\b(?:' + KW.join('|') + ')\\b');
var rxCache = {};
function rxFor(lang) {
  var c = 'slash';
  if (/^(py|python|sh|bash|zsh|shell|yaml|yml|rb|ruby|toml|ini|conf|r|perl|pl|make|dockerfile|nginx)$/.test(lang)) c = 'hash';
  else if (/^(sql|lua|hs|haskell|ada)$/.test(lang)) c = 'dash';
  if (rxCache[c]) return rxCache[c];
  var cm = c === 'hash' ? '#[^\\n]*' : c === 'dash' ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  rxCache[c] = new RegExp(
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' +
    '|(' + cm + ')' +
    '|\\b(0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b' +
    '|(' + KWSET.source.slice(2, -2) + ')', 'g');
  return rxCache[c];
}
function highlight(codeEl) {
  var cls = (codeEl.className || '').match(/language-([\w+#-]+)/);
  if (!cls) return;
  var text = codeEl.textContent;
  if (text.length > 60000) return;
  var rx = rxFor(cls[1].toLowerCase()), out = '', last = 0, m;
  rx.lastIndex = 0;
  while ((m = rx.exec(text))) {
    if (m[0] === '') { rx.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    var k = m[1] ? 'tk-s' : m[2] ? 'tk-c' : m[3] ? 'tk-n' : 'tk-k';
    out += '<span class="' + k + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  if (!out) return;
  out += esc(text.slice(last));
  codeEl.innerHTML = out;
}

DOMPurify.addHook('afterSanitizeAttributes', function (node) {
  if (node.tagName === 'A' && node.getAttribute('href') && !/^#/.test(node.getAttribute('href'))) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
var PURIFY = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['target', 'rel', 'id', 'align', 'start', 'checked', 'disabled', 'type', 'colspan', 'rowspan', 'open']
};

function mdToHtml(src) {
  fnDefs = {}; fnOrder = [];
  var html = marked.parse(src);
  var ids = fnOrder.slice();
  Object.keys(fnDefs).forEach(function (k) { if (ids.indexOf(k) < 0) ids.push(k); });
  if (ids.length) {
    var li = ids.map(function (id) {
      var k = esc(id);
      return '<li id="fn-' + k + '">' + (fnDefs[id] || '') +
        ' <a href="#fnref-' + k + '" aria-label="Back to text">&#8617;</a></li>';
    }).join('');
    html += '<section class="fn"><h2>Notes</h2><ol>' + li + '</ol></section>';
  }
  return DOMPurify.sanitize(html, PURIFY);
}

function slug(s) {
  return s.toLowerCase().trim().replace(/[^\w\u00c0-\uffff\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'section';
}

/* ---------------- document state ---------------- */
var doc = null;   // {id,name,text,size}
var meta = null;  // {id,name,title,size,added,opens,pos,annos}
var clean = [];   // per-block pristine HTML
var heads = [];   // {bi,t} for every heading, used to label the saved position

function render(text) {
  var fmSplit = splitFront(text);
  var head = '';
  if (fmSplit.fm && fmSplit.fm.length) {
    head = '<div class="fm">' + fmSplit.fm.map(function (kv) {
      return '<b>' + esc(kv[0]) + ':</b> ' + esc(kv[1]);
    }).join('<br>') + '</div>';
  }
  reader.innerHTML = head + mdToHtml(fmSplit.body);

  // heading ids
  var used = {};
  $$('h1,h2,h3,h4,h5,h6', reader).forEach(function (h) {
    if (h.id) return;
    var b = slug(h.textContent);
    used[b] = (used[b] || 0) + 1;
    h.id = used[b] > 1 ? b + '-' + used[b] : b;
  });
  // scrollable tables
  $$('#reader > table').forEach(function (t) {
    var w = document.createElement('div'); w.className = 'tw';
    t.parentNode.insertBefore(w, t); w.appendChild(t);
  });
  // task list items
  $$('#reader li > input[type=checkbox]').forEach(function (i) { i.parentNode.classList.add('task'); });
  // syntax colour
  $$('#reader pre > code').forEach(highlight);

  // index blocks + snapshot pristine markup
  clean = []; btCache = []; heads = [];
  Array.prototype.forEach.call(reader.children, function (el, i) {
    el.dataset.bi = i;
    clean.push(el.innerHTML);
    if (/^H[1-6]$/.test(el.tagName)) heads.push({ bi: i, t: el.textContent.trim() });
  });
  Array.prototype.forEach.call(reader.children, function (el) { decorate(el); });
}

function decorate(el) {
  (el.tagName === 'PRE' ? [el] : $$('pre', el)).forEach(function (pre) {
    if (pre.querySelector('.cp')) return;
    var b = document.createElement('button');
    b.className = 'cp'; b.textContent = 'Copy';
    b.setAttribute('data-nowalk', '');
    b.addEventListener('click', function () {
      copy((pre.querySelector('code') || pre).textContent);
      b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1200);
    });
    pre.appendChild(b);
  });
}

function copy(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { toast('Copied'); }, function () { toast('Copy blocked'); });
  } else {
    var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) {}
    document.body.removeChild(ta);
  }
}

/* ---------------- text offsets ---------------- */
function textNodes(root) {
  var out = [];
  var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (n.nodeType === 1) return n.hasAttribute('data-nowalk') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var n; while ((n = w.nextNode())) out.push(n);
  return out;
}
function blockText(el) {
  return textNodes(el).map(function (n) { return n.data; }).join('');
}
/* Highlights wrap text in <mark> but add no characters, so a block's text is
   fixed once rendered. Cache it: find-in-page walked all 628 blocks per keystroke. */
var btCache = [];
function blockTextAt(bi) {
  if (btCache[bi] == null) btCache[bi] = blockText(reader.children[bi]);
  return btCache[bi];
}
function offsetIn(block, container, offset) {
  var pt = document.createRange();
  try { pt.setStart(container, offset); } catch (e) { return 0; }
  pt.collapse(true);
  var nodes = textNodes(block), acc = 0;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], a, b;
    try { a = pt.comparePoint(n, 0); b = pt.comparePoint(n, n.data.length); } catch (e) { continue; }
    if (b <= 0) { acc += n.data.length; continue; }
    if (a >= 0) break;
    return acc + (container === n ? offset : 0);
  }
  return acc;
}
function blockOf(node) {
  var el = node.nodeType === 1 ? node : node.parentNode;
  while (el && el !== reader && el.parentNode !== reader) el = el.parentNode;
  return el && el.parentNode === reader ? el : null;
}
function wrapRange(block, s, e, attrs, cls) {
  var nodes = textNodes(block), acc = 0, jobs = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], ns = acc, ne = acc + n.data.length; acc = ne;
    if (ne <= s || ns >= e) continue;
    jobs.push({ n: n, a: Math.max(0, s - ns), b: Math.min(n.data.length, e - ns) });
  }
  var made = [];
  jobs.forEach(function (j) {
    var node = j.n;
    if (j.b < node.data.length) node.splitText(j.b);
    if (j.a > 0) node = node.splitText(j.a);
    if (!node.data.length) return;
    var m = document.createElement('mark');
    m.className = cls;
    Object.keys(attrs || {}).forEach(function (k) { m.setAttribute(k, attrs[k]); });
    node.parentNode.insertBefore(m, node);
    m.appendChild(node);
    made.push(m);
  });
  return made;
}

/* ---------------- annotations ---------------- */
function annosFor(bi) {
  return (meta.annos || []).filter(function (a) {
    return a.parts.some(function (p) { return p.bi === bi; });
  });
}
function paintBlock(bi) {
  var el = reader.children[bi];
  if (!el) return;
  if (fx.length) clearFind();
  el.innerHTML = clean[bi];
  annosFor(bi).forEach(function (a) {
    a.parts.forEach(function (p) {
      if (p.bi !== bi) return;
      wrapRange(el, p.s, p.e, { 'data-id': a.id, 'data-c': a.c }, 'an' + (a.note ? ' has' : ''));
    });
  });
  decorate(el);
}
function paintAll() {
  var seen = {};
  (meta.annos || []).forEach(function (a) {
    a.parts.forEach(function (p) { seen[p.bi] = 1; });
  });
  Object.keys(seen).forEach(function (bi) { paintBlock(+bi); });
  drawRail();
}

/* The toolbar sits outside the text, and on Android tapping it can collapse the
   selection before the handler runs, so work from the range captured in showSel(). */
function makeAnno(color) {
  var cap = lastSel;
  if (!cap) return null;
  var r = cap.r;
  var b1 = blockOf(r.startContainer), b2 = blockOf(r.endContainer);
  if (!b1 || !b2) return null;
  var i1 = +b1.dataset.bi, i2 = +b2.dataset.bi, parts = [];
  for (var i = i1; i <= i2; i++) {
    var el = reader.children[i], len = blockTextAt(i).length;
    var s = i === i1 ? offsetIn(el, r.startContainer, r.startOffset) : 0;
    var e = i === i2 ? offsetIn(el, r.endContainer, r.endOffset) : len;
    s = clamp(s, 0, len); e = clamp(e, 0, len);
    if (e > s) parts.push({ bi: i, s: s, e: e });
  }
  if (!parts.length) return null;
  var a = {
    id: uid(), c: color || 1, note: '', at: Date.now(), parts: parts,
    text: cap.t.replace(/\s+/g, ' ').trim().slice(0, 400)
  };
  meta.annos = meta.annos || [];
  meta.annos.push(a);
  clearCS();
  try { getSelection().removeAllRanges(); } catch (e) {}
  parts.forEach(function (p) { paintBlock(p.bi); });
  persistMeta(); drawRail();
  return a;
}
function delAnno(id) {
  var a = findAnno(id); if (!a) return;
  meta.annos = meta.annos.filter(function (x) { return x.id !== id; });
  a.parts.forEach(function (p) { paintBlock(p.bi); });
  persistMeta(); drawRail(); renderNotes();
}
function findAnno(id) {
  return (meta.annos || []).filter(function (a) { return a.id === id; })[0];
}

/* ---------------- rail + progress ---------------- */
var drawRail = debounce(function () {
  if (!meta || !S.rail) { railEl.innerHTML = ''; railThumb = null; return; }
  measure();
  var h = docH;
  var frag = document.createDocumentFragment();
  (meta.annos || []).forEach(function (a) {
    var m = reader.querySelector('mark.an[data-id="' + a.id + '"]');
    if (!m) return;
    var top = m.getBoundingClientRect().top + window.scrollY;
    var d = document.createElement('div');
    d.className = 'tk' + (a.note ? ' n' : '');
    d.dataset.c = a.c; d.dataset.id = a.id;
    d.style.top = (clamp(top / h, 0, 1) * (railH - 4)) + 'px';
    d.title = a.text.slice(0, 60);
    frag.appendChild(d);
  });
  var thumb = document.createElement('div');
  thumb.id = 'railThumb';
  var vh = innerHeight / h;
  thumb.style.height = Math.max(18, vh * railH) + 'px';
  thumb.style.top = (window.scrollY / h) * railH + 'px';
  railEl.innerHTML = ''; railEl.appendChild(frag); railEl.appendChild(thumb);
  railThumb = thumb;
}, 90);

/* Document height only changes on render, resize or a settings change — never on
   scroll. Caching it keeps the scroll handler write-only, so nothing in the scroll
   path forces a synchronous layout of a 600-block document. */
var docH = 1, railH = 1, progBar = $('#progress i');
function measure() {
  docH = document.documentElement.scrollHeight || 1;
  railH = railEl.clientHeight || 1;
}
function updateProgress() {
  var h = docH - innerHeight;
  progBar.style.width = ((h > 0 ? clamp(window.scrollY / h, 0, 1) : 0) * 100).toFixed(2) + '%';
  var t = railThumb;
  if (t) t.style.top = (window.scrollY / docH) * railH + 'px';
}

/* ---------------- reading position ---------------- */
/* Blocks are in normal flow, so their tops increase monotonically with index.
   Binary search keeps this ~10 rect reads instead of one per block (628 in a
   100 KB document), because it runs on every throttled scroll save. */
function currentPos() {
  var kids = reader.children, n = kids.length, top = window.scrollY + BAR + 10;
  if (!n) return { bi: 0, frac: 0 };
  var lo = 0, hi = n - 1, ans = n - 1, r, abs;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    r = kids[mid].getBoundingClientRect(); abs = r.top + window.scrollY;
    if (abs + r.height > top) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  r = kids[ans].getBoundingClientRect(); abs = r.top + window.scrollY;
  return { bi: ans, frac: r.height ? clamp((top - abs) / r.height, 0, 1) : 0 };
}
/* Restoring once isn't enough: block heights can settle after the first paint, so
   re-apply a few times and abandon the moment the reader interacts. */
var restoring = false;
function restorePosSafe(p) {
  if (!p) return;
  restoring = true;
  restorePos(p);
  var tries = 0;
  (function tick() {
    if (!restoring) return;
    restorePos(p);
    if (++tries < 3) setTimeout(tick, 110); else restoring = false;
  })();
}
['touchstart', 'wheel', 'keydown', 'mousedown'].forEach(function (ev) {
  window.addEventListener(ev, function () { restoring = false; }, { passive: true });
});
function restorePos(p) {
  if (!p) return;
  var el = reader.children[p.bi];
  if (!el) return;
  var r = el.getBoundingClientRect();
  window.scrollTo(0, Math.max(0, r.top + window.scrollY - BAR - 10 + (p.frac || 0) * r.height));
}
/* The saved position carries the enclosing heading and a percentage so the file
   chooser can say *where* you stopped, not just that you stopped somewhere. */
function labelFor(bi) {
  var lo = 0, hi = heads.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (heads[mid].bi <= bi) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? '' : heads[ans].t;
}
function markPos() {
  var p = currentPos();
  p.label = labelFor(p.bi);
  p.pct = Math.round(clamp(window.scrollY / Math.max(1, docH - innerHeight), 0, 1) * 100);
  p.at = Date.now();
  return p;
}
var savePos = debounce(function () {
  if (!meta || !reader.children.length || restoring) return;
  meta.pos = markPos();
  persistMeta();
}, 400);

var persistMeta = debounce(function () {
  if (meta) DB.put('meta', meta).catch(function () { toast('Could not save'); });
}, 200);

/* ---------------- open / close documents ---------------- */
function openText(text, name, id) {
  text = text.replace(/\r\n/g, '\n');
  var did = id || hashOf(name + '|' + text);
  var nbytes = byteLen(text);
  doc = { id: did, name: name, text: text, size: nbytes, added: Date.now() };
  return DB.get('meta', did).then(function (m) {
    var t = (splitFront(text).fm || []).filter(function (k) { return k[0].toLowerCase() === 'title'; })[0];
    var firstH = /^#\s+(.+)$/m.exec(splitFront(text).body);
    meta = m || {
      id: did, name: name, title: (t && t[1]) || (firstH && firstH[1]) || name.replace(/\.[^.]+$/, ''),
      size: nbytes, added: Date.now(), opens: [], pos: null, annos: []
    };
    meta.name = name; meta.size = nbytes;
    meta.opens = (meta.opens || []); meta.opens.unshift(Date.now()); meta.opens = meta.opens.slice(0, 200);
    return DB.put('docs', { id: did, name: name, text: text, size: nbytes, added: meta.added });
  }).then(function () {
    return DB.put('meta', meta);
  }).then(function () {
    S.lastDoc = did; saveSettings();
    document.body.classList.remove('empty');
    $('#docTitle').textContent = meta.title;
    document.title = meta.title + ' — Margin';
    render(text);
    paintAll();
    measure();
    restorePosSafe(meta.pos);
    renderToc(); renderNotes(); renderInfo();
    setTimeout(function () { measure(); drawRail(); updateProgress(); }, 60);
    toast(meta.pos ? 'Resumed where you left off' : 'Opened ' + name);
  }).catch(function (e) {
    console.error(e); toast('Could not open file');
  });
}

function openFile(file) {
  if (!file) return;
  if (file.size > 12e6) { toast('File is too large'); return; }
  file.text().then(function (t) { openText(t, file.name); });
}

/* ---------------- panels ---------------- */
function renderToc() {
  var box = $('#tocList'), hs = $$('h1,h2,h3,h4,h5,h6', reader);
  box.innerHTML = '';
  if (!hs.length) { box.innerHTML = '<p class="empty-note">This document has no headings.</p>'; return; }
  hs.forEach(function (h) {
    var b = document.createElement('button');
    b.className = 'item toc-l' + h.tagName[1];
    b.innerHTML = '<span class="body"><span class="t"></span></span>';
    b.querySelector('.t').textContent = h.textContent;
    b.addEventListener('click', function () {
      closeSheets();
      window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - BAR - 12);
    });
    box.appendChild(b);
  });
}

function renderNotes() {
  var box = $('#notesList'); box.innerHTML = '';
  var list = (meta && meta.annos || []).slice().sort(function (a, b) {
    return a.parts[0].bi - b.parts[0].bi || a.parts[0].s - b.parts[0].s;
  });
  $('#noteCount').textContent = list.length ? list.length : '';
  if (!list.length) {
    box.innerHTML = '<p class="empty-note">Select any text in the document to highlight it or attach a note.</p>';
    return;
  }
  list.forEach(function (a) {
    var row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = '<span class="dot" data-c="' + a.c + '"></span><span class="body">' +
      '<span class="t"></span><span class="s"></span></span><button class="x" aria-label="Remove">&times;</button>';
    row.querySelector('.t').textContent = a.note || a.text;
    row.querySelector('.s').textContent = a.note ? '“' + a.text.slice(0, 70) + '”' : fmtShort(a.at);
    row.querySelector('.body').addEventListener('click', function () {
      closeSheets(); jumpTo(a.id);
    });
    row.querySelector('.x').addEventListener('click', function (e) {
      e.stopPropagation(); delAnno(a.id);
    });
    box.appendChild(row);
  });
}

function jumpTo(id) {
  var m = reader.querySelector('mark.an[data-id="' + id + '"]');
  if (!m) return;
  window.scrollTo(0, m.getBoundingClientRect().top + window.scrollY - BAR - 60);
  m.classList.add('live');
  setTimeout(function () { m.classList.remove('live'); }, 1400);
}

function renderInfo() {
  var box = $('#docInfo');
  if (!meta) { box.textContent = 'No file open.'; return; }
  var words = 0;
  for (var i = 0; i < reader.children.length; i++) {
    var t = blockTextAt(i).trim();
    if (t) words += t.split(/\s+/).length;
  }
  var opens = (meta.opens || []).slice(0, 8).map(function (t) { return '<li>' + fmtDate(t) + '</li>'; }).join('');
  box.innerHTML =
    '<b>' + esc(meta.title) + '</b><br>' + esc(meta.name) + ' · ' + bytes(meta.size) + ' · ' +
    words.toLocaleString() + ' words · about ' + Math.max(1, Math.round(words / 220)) + ' min<br>' +
    'Highlights and notes: <b>' + ((meta.annos || []).length) + '</b><br>' +
    'Opened <b>' + (meta.opens || []).length + '</b> times' +
    (opens ? '<ol>' + opens + '</ol>' : '');
}

function renderLibrary() {
  var box = $('#libList');
  box.innerHTML = '<p class="empty-note">Loading…</p>';
  DB.all('meta').then(function (all) {
    all.sort(function (a, b) { return (b.opens && b.opens[0] || 0) - (a.opens && a.opens[0] || 0); });
    box.innerHTML = '';
    if (!all.length) { box.innerHTML = '<p class="empty-note">No files yet.</p>'; return; }
    all.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'item' + (doc && m.id === doc.id ? ' cur' : '');
      row.innerHTML = '<span class="body"><span class="t"></span><span class="s"></span></span>' +
        '<button class="x" aria-label="Remove">&times;</button>';
      row.querySelector('.t').textContent = m.title || m.name;
      row.querySelector('.s').textContent = posLine(m) + ' · ' + fmtWhen(m.opens && m.opens[0]) +
        ' · ' + ((m.annos || []).length) + ' notes · ' + bytes(m.size || 0);
      row.querySelector('.body').addEventListener('click', function () {
        DB.get('docs', m.id).then(function (d) {
          if (!d) { toast('File contents are missing — add it again'); return; }
          closeSheets(); openText(d.text, d.name, d.id);
        });
      });
      row.querySelector('.x').addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Remove "' + (m.title || m.name) + '" and its notes?')) return;
        Promise.all([DB.del('docs', m.id), DB.del('meta', m.id)]).then(function () {
          if (doc && doc.id === m.id) location.reload();
          else { renderLibrary(); renderRecent(); }
        });
      });
      box.appendChild(row);
    });
  });
}

function fmtRel(t) {
  if (!t) return 'not opened yet';
  var d = Math.floor((Date.now() - t) / 864e5);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return d + ' days ago';
  if (d < 60) return 'a month ago';
  return Math.round(d / 30) + ' months ago';
}
/* "yesterday 1:10 pm" reads better than "yesterday · yesterday 1:10 pm", so the
   absolute date only appears once the relative one stops being precise. */
function fmtWhen(t) {
  if (!t) return 'not opened yet';
  var rel = fmtRel(t), abs = fmtShort(t);
  return rel === 'today' || rel === 'yesterday' ? abs : rel + ' · ' + abs;
}
function posLine(m) {
  var p = m.pos;
  if (!p) return 'not started';
  var bits = [];
  if (p.label) bits.push(p.label.length > 46 ? p.label.slice(0, 44) + '…' : p.label);
  if (typeof p.pct === 'number') bits.push(p.pct + '%');
  return bits.length ? bits.join(' · ') : 'in progress';
}
function openById(id) {
  return DB.get('docs', id).then(function (d) {
    if (!d) { toast('File contents are missing — add it again'); return; }
    return openText(d.text, d.name, d.id);
  });
}

/* The launcher: every file you've opened, where you stopped in each, and when. */
function renderRecent() {
  var ul = $('#recentList'), card = $('#continueCard'), head = $('#recentHead');
  ul.innerHTML = '';
  return DB.all('meta').then(function (all) {
    all.sort(function (a, b) { return (b.opens && b.opens[0] || 0) - (a.opens && a.opens[0] || 0); });
    head.hidden = !all.length;

    var top = all[0];
    if (top) {
      card.hidden = false;
      card.innerHTML = '<span class="k">' + (top.pos ? 'Continue reading' : 'Most recent') +
        '</span><span class="t"></span><span class="s"></span>';
      card.querySelector('.t').textContent = top.title || top.name;
      card.querySelector('.s').textContent =
        posLine(top) + ' · ' + (top.pos ? 'left off ' : 'opened ') + fmtWhen(top.opens && top.opens[0]);
      card.onclick = function () { openById(top.id); };
    } else {
      card.hidden = true;
    }

    all.forEach(function (m) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'rec';
      b.innerHTML = '<span class="t"></span><span class="d"></span><span class="bar"><i></i></span>';
      b.querySelector('.t').textContent = m.title || m.name;
      b.querySelector('.d').textContent =
        posLine(m) + '\n' + fmtWhen(m.opens && m.opens[0]) +
        ' · opened ' + ((m.opens || []).length) + '\u00d7' +
        ((m.annos || []).length ? ' · ' + m.annos.length + ' notes' : '');
      b.querySelector('.bar i').style.width = ((m.pos && m.pos.pct) || 0) + '%';
      b.addEventListener('click', function () { openById(m.id); });
      var x = document.createElement('button');
      x.className = 'x'; x.setAttribute('aria-label', 'Remove'); x.innerHTML = '&times;';
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Remove "' + (m.title || m.name) + '" and its notes?')) return;
        Promise.all([DB.del('docs', m.id), DB.del('meta', m.id)]).then(renderRecent);
      });
      li.appendChild(b); li.appendChild(x); ul.appendChild(li);
    });
  });
}

/* ---------------- selection toolbar ---------------- */
var selBar = $('#selBar'), lastSel = null, ov = $('#selOverlay');
function hideSel() { selBar.hidden = true; }

function placeBar(rect) {
  if (!rect || (!rect.width && !rect.height)) return hideSel();
  selBar.hidden = false;
  var w = selBar.offsetWidth, h = selBar.offsetHeight;
  var x = clamp(rect.left + rect.width / 2 - w / 2, 8, Math.max(8, innerWidth - w - 8));
  var y = rect.top + window.scrollY - h - 10;
  if (y < window.scrollY + BAR + 6) y = rect.bottom + window.scrollY + 10;
  selBar.style.left = x + 'px';
  selBar.style.top = y + 'px';
}
function offerRange(r, text) {
  lastSel = { r: r.cloneRange(), t: text };
  var rect; try { rect = r.getBoundingClientRect(); } catch (e) { return hideSel(); }
  placeBar(rect);
}

/* ---- native selection path (mouse / when in-app selection is switched off) ---- */
document.addEventListener('selectionchange', debounce(function () {
  if (csEnabled()) return;
  var sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { lastSel = null; return hideSel(); }
  var r = sel.getRangeAt(0);
  if (!reader.contains(r.commonAncestorContainer)) return hideSel();
  offerRange(r, sel.toString());
}, 120));

/* ---------------- in-app text selection ----------------
   Android has no API to suppress the system selection popup (Search / Share / Web
   search) while native selection stays on. So when in-app selection is enabled the
   reader is `user-select:none` — the OS sees nothing selectable and never shows its
   menu — and selection is done here: long-press picks a word, dragging extends it,
   and the chosen range is painted as rectangles on a layer beneath the text. */
var CS = { range: null, aStart: null, aEnd: null, dragging: false, armed: false,
           timer: null, sx: 0, sy: 0, pt: null, suppressClick: false };
var esTimer = null, esV = 0;

function caretAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    var p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    var r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r;
  }
  return null;
}
function inNoWalk(n) {
  for (var e = n.nodeType === 1 ? n : n.parentNode; e && e !== reader; e = e.parentNode) {
    if (e.nodeType === 1 && e.hasAttribute('data-nowalk')) return true;
  }
  return false;
}
var WORD = /[0-9A-Za-z\u00c0-\u024f\u0370-\u1fff\u2c00-\ud7ff_'’-]/;
function wordAt(x, y) {
  var cr = caretAt(x, y);
  if (!cr) return null;
  var n = cr.startContainer;
  if (n.nodeType !== 3 || !reader.contains(n) || inNoWalk(n)) return null;
  var t = n.data, a = Math.min(cr.startOffset, t.length), b = a;
  while (a > 0 && WORD.test(t[a - 1])) a--;
  while (b < t.length && WORD.test(t[b])) b++;
  if (a === b) { b = Math.min(t.length, a + 1); a = Math.max(0, b - 1); }
  if (a === b) return null;
  var r = document.createRange(); r.setStart(n, a); r.setEnd(n, b); return r;
}
function pointBefore(an, ao, bn, bo) {      // is (an,ao) before (bn,bo)?
  try {
    var r = document.createRange(); r.setStart(an, ao); r.collapse(true);
    return r.comparePoint(bn, bo) > 0;
  } catch (e) { return true; }
}
function paintCS() {
  ov.innerHTML = '';
  if (!CS.range) return;
  var rects, sy = window.scrollY, sx = window.scrollX;
  try { rects = CS.range.getClientRects(); } catch (e) { return; }
  for (var i = 0; i < rects.length; i++) {
    var q = rects[i];
    if (!q.width || !q.height) continue;
    var d = document.createElement('div');
    d.style.left = (q.left + sx) + 'px'; d.style.top = (q.top + sy) + 'px';
    d.style.width = q.width + 'px'; d.style.height = q.height + 'px';
    ov.appendChild(d);
  }
}
function clearCS() {
  CS.range = null; CS.dragging = false; CS.armed = false;
  clearTimeout(CS.timer); stopEdge();
  ov.innerHTML = ''; hideSel(); lastSel = null;
}
function startCS(x, y) {
  var w = wordAt(x, y);
  if (!w) return;
  CS.aStart = { n: w.startContainer, o: w.startOffset };
  CS.aEnd = { n: w.endContainer, o: w.endOffset };
  CS.range = w; CS.dragging = true; CS.armed = false;
  paintCS();
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
}
function extendCS(x, y) {
  var w = wordAt(x, y);
  if (!w) return;
  var r = document.createRange();
  if (pointBefore(w.startContainer, w.startOffset, CS.aStart.n, CS.aStart.o)) {
    r.setStart(w.startContainer, w.startOffset); r.setEnd(CS.aEnd.n, CS.aEnd.o);
  } else {
    r.setStart(CS.aStart.n, CS.aStart.o); r.setEnd(w.endContainer, w.endOffset);
  }
  CS.range = r; paintCS();
}
function edge(y) {
  var top = BAR + 60, bot = innerHeight - 80;
  esV = y < top ? -Math.min(16, (top - y) / 3) : y > bot ? Math.min(16, (y - bot) / 3) : 0;
  if (!esV) return stopEdge();
  if (!esTimer) esTimer = setInterval(function () {
    window.scrollBy(0, esV);
    if (CS.pt) extendCS(CS.pt.x, CS.pt.y);
  }, 16);
}
function stopEdge() { if (esTimer) { clearInterval(esTimer); esTimer = null; } esV = 0; }

reader.addEventListener('touchstart', function (e) {
  if (!csEnabled()) return;
  if (e.touches.length !== 1) { CS.armed = false; clearTimeout(CS.timer); return; }
  if (CS.range) clearCS();
  var t = e.touches[0];
  CS.sx = t.clientX; CS.sy = t.clientY; CS.armed = true;
  clearTimeout(CS.timer);
  CS.timer = setTimeout(function () { if (CS.armed) startCS(CS.sx, CS.sy); }, 380);
}, { passive: true });

reader.addEventListener('touchmove', function (e) {
  if (!csEnabled()) return;
  if (CS.dragging && e.touches.length === 1) {
    e.preventDefault();                       // hold the page still while dragging
    var t = e.touches[0];
    CS.pt = { x: t.clientX, y: t.clientY };
    extendCS(t.clientX, t.clientY);
    edge(t.clientY);
    return;
  }
  if (CS.armed && e.touches.length) {
    var q = e.touches[0];
    if (Math.abs(q.clientX - CS.sx) > 10 || Math.abs(q.clientY - CS.sy) > 10) {
      CS.armed = false; clearTimeout(CS.timer);   // it's a scroll, not a press
    }
  }
}, { passive: false });

reader.addEventListener('touchend', function (e) {
  if (!csEnabled()) return;
  CS.armed = false; clearTimeout(CS.timer); stopEdge();
  if (CS.dragging) {
    CS.dragging = false; CS.suppressClick = true;
    if (CS.range && CS.range.toString().trim()) offerRange(CS.range, CS.range.toString());
    else clearCS();
  }
}, { passive: true });

reader.addEventListener('contextmenu', function (e) { if (csEnabled()) e.preventDefault(); });

$$('#selBar .sw').forEach(function (b) {
  b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  b.addEventListener('click', function () {
    var a = makeAnno(+b.dataset.color);
    hideSel();
    if (a) { renderNotes(); toast('Highlighted'); }
  });
});
$('#selNote').addEventListener('mousedown', function (e) { e.preventDefault(); });
$('#selNote').addEventListener('click', function () {
  var a = makeAnno(1);
  hideSel();
  if (a) { renderNotes(); editNote(a.id); }
});
$('#selCopy').addEventListener('mousedown', function (e) { e.preventDefault(); });
$('#selCopy').addEventListener('click', function () {
  var t = (lastSel && lastSel.t) || getSelection().toString();
  clearCS();
  try { getSelection().removeAllRanges(); } catch (e) {}
  copy(t);
});

/* ---------------- note editor ---------------- */
var editing = null;
function editNote(id) {
  var a = findAnno(id); if (!a) return;
  $('#noteQuote').textContent = a.text;
  $('#noteText').value = a.note || '';
  $$('#noteColors .sw').forEach(function (b) { b.classList.toggle('on', +b.dataset.color === a.c); });
  openSheet($('#sheetNote'));   // clears `editing`, so claim it afterwards
  editing = id;
  setTimeout(function () { $('#noteText').focus(); }, 120);
}
$$('#noteColors .sw').forEach(function (b) {
  b.addEventListener('click', function () {
    var a = findAnno(editing); if (!a) return;
    a.c = +b.dataset.color;
    $$('#noteColors .sw').forEach(function (x) { x.classList.toggle('on', x === b); });
    a.parts.forEach(function (p) { paintBlock(p.bi); });
    persistMeta(); drawRail(); renderNotes();
  });
});
$('#noteSave').addEventListener('click', function () {
  var a = findAnno(editing); if (!a) return;
  a.note = $('#noteText').value.trim();
  a.parts.forEach(function (p) { paintBlock(p.bi); });
  persistMeta(); drawRail(); renderNotes(); closeSheets();
  toast(a.note ? 'Note saved' : 'Note cleared');
});
$('#noteDelete').addEventListener('click', function () {
  if (editing) delAnno(editing);
  closeSheets(); toast('Removed');
});

reader.addEventListener('click', function (e) {
  if (CS.suppressClick) { CS.suppressClick = false; e.preventDefault(); return; }
  var m = e.target.closest ? e.target.closest('mark.an') : null;
  if (m) { e.preventDefault(); editNote(m.dataset.id); }
});
railEl.addEventListener('click', function (e) {
  if (e.target.classList.contains('tk')) jumpTo(e.target.dataset.id);
});

/* ---------------- find ---------------- */
var fx = [], fxi = -1;
function clearFind() {
  $$('mark.fx', reader).forEach(function (m) {
    var p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  });
  fx = []; fxi = -1; $('#findCount').textContent = '0/0';
}
function runFind(q) {
  clearFind();
  if (!q || q.length < 2) return;
  var needle = q.toLowerCase(), total = 0;
  Array.prototype.forEach.call(reader.children, function (el, bi) {
    if (total > 400) return;
    var t = blockTextAt(bi).toLowerCase(), i = 0, hits = [];
    while ((i = t.indexOf(needle, i)) >= 0) { hits.push(i); i += needle.length; if (hits.length > 60) break; }
    for (var k = hits.length - 1; k >= 0; k--) {
      wrapRange(el, hits[k], hits[k] + needle.length, {}, 'fx');
      total++;
    }
  });
  fx = $$('mark.fx', reader);
  $('#findCount').textContent = fx.length ? '1/' + fx.length : '0/0';
  if (fx.length) { fxi = -1; stepFind(1); }
}
function stepFind(d) {
  if (!fx.length) return;
  if (fxi >= 0 && fx[fxi]) fx[fxi].classList.remove('cur');
  fxi = (fxi + d + fx.length) % fx.length;
  fx[fxi].classList.add('cur');
  $('#findCount').textContent = (fxi + 1) + '/' + fx.length;
  window.scrollTo(0, fx[fxi].getBoundingClientRect().top + window.scrollY - BAR - 80);
}
$('#findInput').addEventListener('input', debounce(function (e) { runFind(e.target.value.trim()); }, 220));
$('#findInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFind();
});
$('#findNext').addEventListener('click', function () { stepFind(1); });
$('#findPrev').addEventListener('click', function () { stepFind(-1); });
$('#findClose').addEventListener('click', closeFind);
function closeFind() { clearFind(); $('#findBar').hidden = true; }
function openFind() {
  if (!meta) return toast('Open a file first');
  $('#findBar').hidden = false; $('#findInput').focus(); $('#findInput').select();
}

/* ---------------- sheets ---------------- */
function openSheet(el) {
  closeSheets();
  el.hidden = false; scrim.hidden = false;
}
function closeSheets() {
  $$('.sheet').forEach(function (s) { s.hidden = true; });
  scrim.hidden = true; editing = null;
}
scrim.addEventListener('click', closeSheets);
$$('.grab').forEach(function (g) { g.addEventListener('click', closeSheets); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeSheets(); hideSel(); }
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'f' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openFind(); }
  if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openFind(); }
});

$('#btnSettings').addEventListener('click', function () { openSheet($('#sheetSettings')); });
$('#btnToc').addEventListener('click', function () { renderToc(); openSheet($('#sheetToc')); });
$('#btnNotes').addEventListener('click', function () { renderNotes(); openSheet($('#sheetNotes')); });
$('#btnFind').addEventListener('click', openFind);
$('#btnLibrary').addEventListener('click', function () {
  renderLibrary(); renderInfo(); renderVersion(); openSheet($('#sheetLib'));
});

/* ---------------- settings UI ---------------- */
function syncUI() {
  $$('#segTheme button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === S.theme); });
  $('#selFont').value = S.font;
  $('#rngSize').value = S.size; $('#vSize').textContent = S.size + 'px';
  $('#rngLh').value = S.lh; $('#vLh').textContent = (S.lh / 100).toFixed(2);
  $('#rngW').value = S.width; $('#vW').textContent = S.width + 'rem';
  $('#rngSp').value = S.sp; $('#vSp').textContent = (S.sp / 100).toFixed(2) + 'em';
  $('#ckJustify').checked = !!S.justify;
  $('#ckWrap').checked = !!S.wrapCode;
  $('#ckHide').checked = !!S.autoHide;
  $('#ckRail').checked = !!S.rail;
  $('#ckSelect').checked = csEnabled();
  $('#ckResume').checked = !!S.resume;
}
function reflow(fn) {
  var p = meta && reader.children.length ? currentPos() : null;
  fn();
  applySettings();
  if (p) restorePos(p);
  measure(); drawRail(); updateProgress();
}
$$('#segTheme button').forEach(function (b) {
  b.addEventListener('click', function () { reflow(function () { S.theme = b.dataset.v; }); syncUI(); });
});
$('#selFont').addEventListener('change', function (e) { reflow(function () { S.font = e.target.value; }); });
$('#rngSize').addEventListener('input', function (e) { reflow(function () { S.size = +e.target.value; }); syncUI(); });
$('#rngLh').addEventListener('input', function (e) { reflow(function () { S.lh = +e.target.value; }); syncUI(); });
$('#rngW').addEventListener('input', function (e) { reflow(function () { S.width = +e.target.value; }); syncUI(); });
$('#rngSp').addEventListener('input', function (e) { reflow(function () { S.sp = +e.target.value; }); syncUI(); });
$('#ckJustify').addEventListener('change', function (e) { reflow(function () { S.justify = e.target.checked; }); });
$('#ckWrap').addEventListener('change', function (e) { reflow(function () { S.wrapCode = e.target.checked; }); });
$('#ckHide').addEventListener('change', function (e) {
  S.autoHide = e.target.checked; saveSettings();
  if (!S.autoHide) $('#bar').classList.remove('up');
});
$('#ckRail').addEventListener('change', function (e) { S.rail = e.target.checked; applySettings(); drawRail(); });
$('#ckSelect').addEventListener('change', function (e) {
  S.customSel = e.target.checked; clearCS(); applySettings(); saveSettings();
});
$('#ckResume').addEventListener('change', function (e) { S.resume = e.target.checked; saveSettings(); });

/* ---------------- import / export ---------------- */
$('#btnOpen').addEventListener('click', function () { $('#file').click(); });
$('#btnAdd').addEventListener('click', function () { $('#file').click(); });
$('#file').addEventListener('change', function (e) {
  if (e.target.files[0]) { closeSheets(); openFile(e.target.files[0]); }
  e.target.value = '';
});
$('#btnPaste').addEventListener('click', function () { openSheet($('#sheetPaste')); });
$('#pasteGo').addEventListener('click', function () {
  var t = $('#pasteText').value;
  if (!t.trim()) return toast('Nothing to open');
  closeSheets();
  openText(t, ($('#pasteName').value || 'pasted.md').trim());
  $('#pasteText').value = '';
});

['dragenter', 'dragover'].forEach(function (ev) {
  document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
});
['dragleave', 'drop'].forEach(function (ev) {
  document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); });
});
document.addEventListener('drop', function (e) {
  if (e.dataTransfer && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});

function download(name, text, mime) {
  var b = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  var u = URL.createObjectURL(b), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1000);
}
$('#btnExportNotes').addEventListener('click', function () {
  if (!meta || !(meta.annos || []).length) return toast('No notes yet');
  var list = meta.annos.slice().sort(function (a, b) { return a.parts[0].bi - b.parts[0].bi; });
  var out = '# Notes — ' + meta.title + '\n\n_Source: ' + meta.name + '_\n\n';
  list.forEach(function (a) {
    out += '> ' + a.text + '\n\n';
    if (a.note) out += a.note + '\n\n';
    out += '---\n\n';
  });
  download(meta.name.replace(/\.[^.]+$/, '') + '-notes.md', out, 'text/markdown;charset=utf-8');
});
$('#btnBackup').addEventListener('click', function () {
  Promise.all([DB.all('docs'), DB.all('meta')]).then(function (r) {
    download('margin-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify({ v: 1, settings: S, docs: r[0], meta: r[1] }), 'application/json');
  });
});
$('#btnRestore').addEventListener('click', function () { $('#restoreFile').click(); });
$('#restoreFile').addEventListener('change', function (e) {
  var f = e.target.files[0]; if (!f) return;
  f.text().then(function (t) {
    var d = JSON.parse(t);
    if (!d || d.v !== 1) throw new Error('bad');
    return Promise.all(
      (d.docs || []).map(function (x) { return DB.put('docs', x); })
        .concat((d.meta || []).map(function (x) { return DB.put('meta', x); }))
    );
  }).then(function () { toast('Backup restored'); renderLibrary(); renderRecent(); })
    .catch(function () { toast('That file is not a Margin backup'); });
  e.target.value = '';
});

/* ---------------- version / deploy check ---------------- */
function swVersion() {
  return new Promise(function (res) {
    var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return res(null);
    var ch = new MessageChannel(), done = false;
    ch.port1.onmessage = function (e) { done = true; res(e.data && e.data.version); };
    try { sw.postMessage({ q: 'version' }, [ch.port2]); } catch (e) { return res(null); }
    setTimeout(function () { if (!done) res(null); }, 800);
  });
}
function renderVersion() {
  var box = $('#verInfo');
  if (!box) return;
  swVersion().then(function (v) {
    var https = location.protocol === 'https:' || location.hostname === 'localhost';
    box.innerHTML =
      'App build <b>' + esc(BUILD) + '</b><br>' +
      'Offline cache <b>' + esc(v || (https ? 'not installed yet' : 'unavailable over http')) + '</b><br>' +
      'Runs offline: <b>' + (v ? 'yes' : 'not yet — reload once more') + '</b>';
  });
}
$('#btnUpdate').addEventListener('click', function () {
  if (!navigator.serviceWorker) return toast('No service worker on this browser');
  navigator.serviceWorker.getRegistration().then(function (reg) {
    if (!reg) return toast('Not installed yet — reload the page');
    toast('Checking…');
    return reg.update().then(function () {
      renderVersion();
      toast(swWaiting ? 'Update ready — reload to apply' : 'You are on the latest build');
    });
  }).catch(function () { toast('Could not check'); });
});

/* ---------------- scroll behaviour ---------------- */
var lastY = 0;
window.addEventListener('scroll', function () {
  var y = window.scrollY;
  if (S.autoHide && meta) {
    var bar = $('#bar');
    if (y > 120 && y > lastY + 6) bar.classList.add('up');
    else if (y < lastY - 6 || y < 80) bar.classList.remove('up');
  }
  lastY = y;
  updateProgress();
  savePos();
  if (!CS.range) hideSel();
}, { passive: true });

window.addEventListener('resize', debounce(function () { measure(); drawRail(); updateProgress(); }, 200));
window.addEventListener('pagehide', function () {
  if (meta && reader.children.length && !restoring) { meta.pos = markPos(); DB.put('meta', meta); }
});
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden' && meta && reader.children.length && !restoring) {
    meta.pos = markPos(); DB.put('meta', meta);
  }
});

/* ---------------- pinch to resize (reflow zoom) ---------------- */
var pd = 0, pfs = 0, ppos = null;
function dist(t) {
  var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}
reader.addEventListener('touchstart', function (e) {
  if (e.touches.length === 2) { pd = dist(e.touches); pfs = S.size; ppos = currentPos(); clearCS(); }
}, { passive: true });
reader.addEventListener('touchmove', function (e) {
  if (e.touches.length === 2 && pd) {
    e.preventDefault();
    var k = dist(e.touches) / pd;
    var n = clamp(Math.round(pfs * k), 13, 34);
    if (n !== S.size) { S.size = n; applySettings(); if (ppos) restorePos(ppos); syncUI(); }
  }
}, { passive: false });
reader.addEventListener('touchend', function (e) {
  if (e.touches.length < 2 && pd) { pd = 0; measure(); drawRail(); savePos(); saveSettings(); }
}, { passive: true });
window.addEventListener('wheel', function (e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  var p = currentPos();
  S.size = clamp(S.size + (e.deltaY < 0 ? 1 : -1), 13, 34);
  applySettings(); restorePos(p); syncUI(); drawRail();
}, { passive: false });

/* ---------------- service worker + share target ---------------- */
var swWaiting = false;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          // "installed" with an existing controller means a newer build is ready
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            swWaiting = true;
            toast('New version ready — reload to apply');
          }
        });
      });
    }).catch(function () {});
  });
}
function consumeShare() {
  if (!/[?&]share=1/.test(location.search) || !window.caches) return Promise.resolve(false);
  return caches.open('margin-share').then(function (c) {
    return c.match('shared-file').then(function (res) {
      if (!res) return false;
      var name = decodeURIComponent(res.headers.get('x-name') || 'shared.md');
      return res.text().then(function (t) {
        c.delete('shared-file');
        history.replaceState(null, '', location.pathname);
        openText(t, name);
        return true;
      });
    });
  }).catch(function () { return false; });
}

/* ---------------- boot ---------------- */
applySettings();
syncUI();
renderRecent();
document.body.classList.add('empty');

consumeShare().then(function (done) {
  if (done) return;
  if (S.resume && S.lastDoc) return openById(S.lastDoc);
}).catch(function () {});

})();
