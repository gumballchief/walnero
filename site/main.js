// Store links. Paste each listing's address here once it exists; until then its button says "Soon" and goes nowhere.
const STORES = {
  chrome: '',     // Chrome Web Store listing
  appStore: '',   // Apple App Store listing
  googlePlay: '', // Google Play listing
};

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ic = (n) => `<em style="--u:url(app/${n}.svg)"></em>`;
const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// --- Store buttons ---------------------------------------------------------------------------------------------------
const BUTTONS = [
  { key: 'chrome', icon: 'googlechrome', small: 'Add to', name: 'Chrome', place: 'the Chrome Web Store' },
  { key: 'appStore', icon: 'apple', small: 'Download on the', name: 'App Store', place: 'the App Store' },
  { key: 'googlePlay', icon: 'googleplay', small: 'Get it on', name: 'Google Play', place: 'Google Play' },
];
for (const row of $$('[data-stores]')) {
  for (const b of BUTTONS) {
    const url = STORES[b.key];
    const el = document.createElement(url ? 'a' : 'span');
    el.className = `store ${url ? 'live' : 'soon'}`;
    if (url) Object.assign(el, { href: url, target: '_blank', rel: 'noopener' }); else el.setAttribute('aria-label', `${b.name}, coming soon`);
    el.innerHTML = `<span class="glyph"><i style="--u:url(icons/${b.icon}.svg)"></i></span><span class="lbl"><small>${b.small}</small>${b.name}</span>${url ? '' : '<span class="tag">Soon</span>'}`;
    row.append(el);
  }
}
const waiting = BUTTONS.filter((b) => !STORES[b.key]).map((b) => b.place);
const soonNote = $('[data-soon-note]');
if (!waiting.length) soonNote.remove();
else soonNote.textContent = `Walnero is on its way to ${waiting.length > 1 ? `${waiting.slice(0, -1).join(', ')} and ${waiting.at(-1)}` : waiting[0]}.`;
if (STORES.chrome) for (const a of $$('[data-chrome-link]')) Object.assign(a, { href: STORES.chrome, target: '_blank', rel: 'noopener' });

// --- Digit reels, the same as the app's balance ----------------------------------------------------------------------
function makeReels(el, value) {
  const suffix = [...el.children].filter((n) => n.tagName === 'SMALL');
  el.textContent = '';
  const [whole, cents] = value.split('.');
  let n = 0;
  const digit = (c) => {
    if (!/\d/.test(c)) { const s = document.createElement('span'); s.textContent = c; return s; }
    const d = document.createElement('span');
    d.className = 'd';
    d.innerHTML = `<i>${c}</i><span class="reel" style="transition-delay:${n++ * 45}ms">${'0123456789'.split('').map((x) => `<span>${x}</span>`).join('')}</span>`;
    return d;
  };
  for (const c of whole) el.append(digit(c));
  if (cents !== undefined) {
    const parts = [digit('.'), ...[...cents].map(digit)];
    if (el.classList.contains('a-bal')) { const dim = document.createElement('span'); dim.className = 'cents'; dim.append(...parts); el.append(dim); } else el.append(...parts);
  }
  el.append(...suffix);
}
function roll(el, value, instant = false) {
  const digits = $$('.d', el);
  if (digits.length !== value.replace(/\D/g, '').length) { makeReels(el, value); return roll(el, value, instant); }
  const target = value.replace(/\D/g, '');
  digits.forEach((d, i) => {
    const reel = $('.reel', d);
    if (instant) reel.style.transition = 'none';
    reel.style.transform = `translateY(${-Number(target[i]) * (d.offsetHeight || 52)}px)`;
    $('i', d).textContent = target[i];
    if (instant) { void reel.offsetWidth; reel.style.transition = ''; }
  });
}
const setZero = (el) => $$('.reel', el).forEach((r) => { r.style.transition = 'none'; r.style.transform = 'translateY(0)'; void r.offsetWidth; r.style.transition = ''; });

// --- Real market data for the phones: today's price from CoinGecko, the chart from Kraken -------------------------------
const MK = { price: 488.13, change: 33.25, pct: 7.31, charts: {} };
fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true')
  .then((r) => r.json()).then((d) => { const m = d?.monero; if (m?.usd) { MK.price = m.usd; MK.pct = m.usd_24h_change; MK.change = m.usd - m.usd / (1 + m.usd_24h_change / 100); } }).catch(() => {});
function walk(n, start) { const out = []; let v = start; for (let i = 0; i < n; i++) { v += (Math.sin(i / 9) + (Math.random() - .45)) * 1.6; out.push({ t: Date.now() / 1000 - (n - i) * 300, v }); } return out; }
for (const [range, minutes, keep] of [['1D', 5, 288], ['1W', 60, 168]]) {
  MK.charts[range] = walk(keep, 450);
  fetch(`https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=${minutes}`).then((r) => r.json()).then((d) => {
    const rows = Object.entries(d.result ?? {}).find(([k]) => k !== 'last')?.[1];
    if (rows?.length) MK.charts[range] = rows.slice(-keep).map((r) => ({ t: Number(r[0]), v: Number(r[4]) }));
  }).catch(() => {});
}
// A made-up address for the demos: right length, wrong checksum, so no wallet would ever accept it.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ADDR = '8' + Array.from({ length: 94 }, () => B58[Math.floor(Math.random() * 58)]).join('');
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
let liveBlock = 3811561;

// --- The app's screens, rebuilt at phone size ---------------------------------------------------------------------
const TXS = [
  { in: true, amt: '1.2000', when: 'Just now', status: '3 of 10 checks' },
  { in: false, amt: '0.5000', to: '@kestrel', when: 'Today, 9:12' },
  { in: true, amt: '2.6210', when: 'Yesterday' },
  { in: false, amt: '0.1000', to: '@mira', when: 'Nov 19' },
  { in: true, amt: '0.7500', when: 'Nov 17' },
];
const BAL = '4.8210';
const STARS = '*****';
const TONES = ['#202020', '#1B1B1B', '#171717', '#131313', '#101010', '#0D0D0D'];
const nav = (on) => `<div class="a-nav">${[['home', 'wallet', 'Wallet'], ['activity', 'clock-counter-clockwise', 'Activity'], ['names', 'at', 'Names'], ['settings', 'gear-six', 'Settings']].map(([k, i, l]) => `<span class="${k === on ? 'on' : ''}" data-hit="tab-${k}">${ic(i)}${l}</span>`).join('')}</div>`;
const head = (title) => `<div class="a-head"><span class="bk" data-hit="back">${ic('caret-left')}</span><span>${title}</span></div>`;
const slip = (i, inner, hit) => `<div class="a-slip" style="--i:${i};--tone:${TONES[Math.min(i, 5)]}"${hit ? ` data-hit="${hit}"` : ''}>${inner}</div>`;
const txRow = (d, t, i) => slip(i, `<span class="g">${ic(t.in ? 'arrow-down-left' : 'arrow-up-right')}</span><div><div class="n">${t.in ? 'Received' : `Sent to ${t.to}`}</div><div class="t">${t.when}</div></div><div class="e"><b data-amt-hide>${d.state.hidden ? STARS : `${t.in ? '+' : '-'}${t.amt}`}</b><div class="t">XMR</div></div>`, `tx${i}`);
const moneroRow = (d) => slip(0, `<img src="app/xmr.png" alt=""><div><div class="n">Monero</div><div class="t">${d.state.test ? 'Test network' : `${usd(MK.price)} <span class="${MK.pct < 0 ? 'down' : 'up'}">${MK.pct < 0 ? '' : '+'}${MK.pct.toFixed(2)}%</span>`}</div></div><div class="e"><b data-amt-hide>${d.state.hidden ? STARS : d.state.test ? d.testBal : BAL}</b><div class="t" data-amt-hide2>${d.state.test ? 'XMR' : d.state.hidden ? STARS : usd(MK.price * Number(BAL))}</div></div>`, 'monero');
const faucet = () => `<div class="fc" data-hit="faucet"><span class="g">${ic('drop')}</span><div><b data-fct>Need test coins?</b><span data-fcs>0.01 test XMR from the faucet, once an hour</span></div><span class="go">Get</span></div>`;
const btn = (label, hit, kind = '') => `<div class="a-btn wide ${kind}" data-hit="${hit}"><b>${label}</b></div>`;

const SCREENS = {
  lock: () => `<div class="scr lock"><img class="w" src="art/w-sky.png" alt=""><div class="a-title">Welcome back.</div><div class="pw" data-hit="pw" data-pw><span class="ph">Password</span></div><div class="lock-btn">${btn('Unlock', 'unlock', 'hit')}</div></div>`,
  faceid: () => `<div class="scr lock"><img class="w" src="art/w-sky.png" alt=""><div class="a-title">Welcome back.</div><div class="fid" data-fid>${ic('scan-smiley')}</div><div class="fid-word" data-fidw>Face ID</div><div class="lock-btn">${btn('Use password', 'usepw')}</div></div>`,
  home: (d) => `<div class="scr">
    <div class="a-head"><img src="art/w-sky.png" alt=""><span>${d.state.test ? 'Test wallet' : 'Main wallet'}</span></div>
    <div class="a-bal" data-hit="bal" data-bal><small>XMR</small></div>
    <div class="a-sub"><span data-sync>Up to date</span><span class="a-bars" data-bars>${'<i class="lit"></i>'.repeat(14)}</span></div>
    <div class="a-fold"><span class="a-btn hit" data-hit="send"><b>Send</b></span><span class="a-btn" data-hit="receive"><b>Receive</b></span><span class="a-btn" data-hit="swap"><b>Swap</b></span></div>
    <div class="a-label"><h3>Tokens</h3><span class="a-lines">${ic('list')}</span></div>
    <div class="a-stack">${moneroRow(d)}</div>
    ${d.state.test ? faucet() : ''}
    ${nav('home')}</div>`,
  activity: (d) => `<div class="scr"><div class="a-title" style="margin-top:4px">Activity</div><div class="a-stack" style="margin-top:12px">${TXS.map((t, i) => txRow(d, t, i)).join('')}</div>${nav('activity')}</div>`,
  token: (d) => `<div class="scr">${head('Monero')}
    <div class="t-price" data-tprice>${usd(MK.price)}</div>
    <div class="t-chg ${MK.pct < 0 ? 'down' : 'up'}" data-tchg></div>
    <div class="t-chart" data-chart></div>
    <div class="t-ranges">${['1D', '1W', '1M', 'YTD', 'ALL'].map((r) => `<span class="${r === d.range ? 'on' : ''}" data-hit="r-${r}"><b>${r}</b></span>`).join('')}</div>
    <div class="a-fold"><span class="a-btn hit"><b>Send</b></span><span class="a-btn"><b>Receive</b></span><span class="a-btn"><b>Swap</b></span></div>
    <div class="a-label"><h3>Your balance</h3></div>
    <div class="a-stack">${slip(0, `<img src="app/xmr.png" alt=""><div><div class="n">Monero</div><div class="t">${BAL} XMR</div></div><div class="e"><b>${usd(MK.price * Number(BAL))}</b><div class="t up">+${usd(Math.abs(MK.change) * Number(BAL))} today</div></div>`)}</div></div>`,
  tx: () => `<div class="scr">${head('Received')}
    <div class="x-top"><div class="x-glyph">${ic('arrow-down-left')}</div><div class="x-amt">+1.2000<small>XMR</small></div><div class="x-val">About ${usd(MK.price * 1.2)} at today's price</div></div>
    <div class="a-card">
      <div><span>Date</span><b>Today, 9:41 AM</b></div>
      <div><span>Status</span><b style="color:var(--sky)" data-status>3 of 10 checks</b></div>
      <div><span>From</span><b>Hidden by Monero</b></div>
      <div><span>To</span><b>This wallet, ${short(ADDR)}</b></div>
      <div><span>Network</span><b>Monero</b></div>
      <div><span>Block</span><b>${commas(liveBlock)}</b></div>
      <div><span>Transaction ID</span><span class="id" data-hit="copyid">6efbfd…f9669b ${ic('copy')}</span></div>
    </div>
    <div style="margin-top:12px">${btn(`View on XMRScan ${ic('arrow-square-out')}`, 'xmrscan')}</div>
    <div class="a-note" style="font-size:10px">XMRScan sees this ID and your connection. It can't see amounts or addresses.</div></div>`,
  receive: () => `<div class="scr">${head('Receive')}<div class="a-title">Get paid.</div><img class="r-qr" src="app/qr.svg" alt=""><div class="r-addr">${ADDR}</div><div class="a-note" style="text-align:center">A new address each time, all going to the same wallet.</div><div class="grow"></div><div style="margin-bottom:30px">${btn('Copy address', 'copy', 'hit')}</div></div>`,
  send: () => `<div class="scr">${head('Send')}
    <div class="s-word" style="margin-top:8px">Send</div>
    <div class="s-chip" data-amtchip><img src="app/xmr.png" alt=""><span data-amt><span class="ph">0</span></span><span class="u">XMR</span></div>
    <div class="s-word">to</div>
    <div class="s-chip" data-namechip><span class="at">@</span><span data-name><span class="ph">a name</span></span></div>
    <div class="s-names" data-names><span data-hit="n-kestrel">@kestrel</span><span>@mira</span><span>@nyx</span></div>
    <div class="s-fee"><span data-fee>You have ${BAL} XMR</span><span>~2 min</span></div>
    <div class="s-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '<'].map((k) => `<span data-key="${k}">${k === '<' ? ic('backspace') : k}</span>`).join('')}</div>
    <div class="s-slide" data-slide><i class="fill">${ic('arrow-right')}</i><span class="tip">Slide to send</span></div></div>`,
  sent: () => `<div class="scr sky"><div class="ok">${ic('check')}</div><div class="sent-word">Sent.</div><div class="sent-d">0.50 XMR to @kestrel</div><div class="sent-n">Fee 0.000031 XMR. It lands in the next block, about 2 minutes.</div><div class="grow"></div><div style="margin-bottom:34px">${btn('Done', 'done', 'ink')}</div></div>`,
  names: (d) => `<div class="scr"><div class="a-title" style="margin-top:4px">Names</div><div class="a-note">Addresses you've saved under a name, so you can send without pasting.</div>
    <div class="a-stack" style="margin-top:12px">${[...(d.added ? ['kestrel'] : []), 'mira', 'nyx'].map((n, i) => slip(i, `<span class="g">@</span><div><div class="n">@${n}</div><div class="t">${short(ADDR.slice(i) + ADDR.slice(0, i))}</div></div><div class="e chev">${ic('caret-right')}</div>`)).join('')}</div>
    <div class="grow"></div><div style="margin-bottom:88px">${btn('Add a name', 'addname', 'hit')}</div>${nav('names')}</div>`,
  nameadd: () => `<div class="scr">${head('New name')}<div class="s-word" style="margin-top:10px">Save</div><div class="n-box" data-hit="nbox" data-nbox><span style="color:var(--faint)">Paste a Monero address</span></div><div class="s-word">as</div><div class="s-chip" data-hit="nchip" data-nchip><span class="at">@</span><span data-nname><span class="ph">name</span></span></div><div class="grow"></div><div style="margin-bottom:30px">${btn('Save name', 'save', 'hit')}</div></div>`,
  settings: () => `<div class="scr"><div class="a-title" style="margin-top:4px">Settings</div>
    <div class="who"><span class="av"><img src="art/w-sky.png" alt="" style="filter:brightness(0) saturate(100%) invert(10%) sepia(40%) saturate(2000%) hue-rotate(195deg)"></span><div><b>Main wallet</b><span>${short(ADDR)}</span></div></div>
    <div class="a-stack m-group">${[['shield-check', 'Security & Privacy', 'Face ID, recovery words, auto-lock'], ['at', 'Names', 'Addresses you saved'], ['globe-hemisphere-west', 'Network', 'Servers, fast open, full check'], ['code', 'Developer settings', 'Test network, open speed', 'dev']].map(([i, t, s, hit], k) => slip(k, `<span class="g">${ic(i)}</span><div><div class="n">${t}</div><div class="t">${s}</div></div><div class="e chev">${ic('caret-right')}</div>`, hit)).join('')}</div>${nav('settings')}</div>`,
  developer: () => `<div class="scr">${head('Settings')}<div class="a-title">Developer settings</div><div class="a-note">For trying things out. Nothing here touches your real Monero.</div>
    <div class="a-stack m-group">${slip(0, `<span class="g">${ic('code')}</span><div><div class="n">Test network</div><div class="t">Free test coins, no value</div></div><div class="e"><span class="tg" data-hit="tn"><i></i></span></div>`)}${slip(1, `<span class="g">${ic('lightning')}</span><div><div class="n">Open speed</div><div class="t" style="color:var(--up);font-family:var(--code)">balance 0.3 s, up to date 1.2 s</div></div>`)}</div></div>`,
  pay: () => `<div class="scr"><div class="a-head"><img src="art/w-sky.png" alt=""><span>Main wallet</span></div><div class="b-site"><i></i><span><b>shop.example</b> is asking for a payment</span></div>
    <div class="s-word" style="margin-top:10px">Pay</div><div class="s-chip hit"><img src="app/xmr.png" alt=""><span>0.0489</span><span class="u">XMR</span></div><div class="s-word">to</div><div class="s-chip"><span style="font-size:22px">shop.example</span></div>
    <div class="s-fee"><span>Fee about 0.00003 XMR</span><span>~2 min</span></div><div class="grow"></div><div class="s-slide" data-slide style="margin-bottom:20px"><i class="fill">${ic('arrow-right')}</i><span class="tip">Slide to pay</span></div></div>`,
  paid: () => `<div class="scr sky"><div class="ok">${ic('check')}</div><div class="sent-word">Paid.</div><div class="sent-d">0.0489 XMR to shop.example</div><div class="sent-n">The shop sees it in the next block.</div></div>`,
};

// What a screen does when it appears: balance reels, the chart drawing itself.
const SETUP = {
  home(d, scr) {
    const bal = $('[data-bal]', scr);
    if (d.state.hidden) { bal.innerHTML = `<span class="stars">${STARS}</span><small>XMR</small>`; return; }
    const value = d.state.test ? d.testBal : BAL;
    makeReels(bal, value);
    if (!d.rollIn) { roll(bal, value, true); return; }
    setZero(bal);
    if (d.rollIn === 'digits') { setTimeout(() => roll(bal, value), 120); return; }
    const bars = $$('[data-bars] i', scr); bars.forEach((b) => b.classList.remove('lit'));
    $('[data-sync]', scr).textContent = 'Checking for new payments';
    setTimeout(() => roll(bal, value), 250);
    bars.forEach((b, i) => setTimeout(() => b.classList.add('lit'), 200 + i * 55));
    setTimeout(() => { $('[data-sync]', scr).textContent = 'Up to date'; }, 1100);
  },
  token(d, scr) { drawChart(d, scr); },
};

function drawChart(d, scr = d.scr) {
  const pts = MK.charts[d.range] ?? MK.charts['1D'];
  const W = 288; const H = 150;
  const vals = pts.map((p) => p.v); const lo = Math.min(...vals); const hi = Math.max(...vals);
  const x = (i) => (i / (pts.length - 1)) * W; const y = (v) => H - 10 - ((v - lo) / (hi - lo || 1)) * (H - 28);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const box = $('[data-chart]', scr);
  box.classList.remove('drawn', 'scrubbing');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="area" d="${line}L${W},${H}L0,${H}Z" fill="rgba(124,196,255,.1)"/><path class="line" d="${line}"/><line class="scrub" x1="0" x2="0" y1="0" y2="${H}" stroke="rgba(124,196,255,.45)"/><circle class="scrub" r="4.5" fill="#7CC4FF" stroke="#000" stroke-width="2"/></svg>`;
  const path = $('.line', box); box.style.setProperty('--len', String(Math.ceil(path.getTotalLength())));
  d.chart = { pts, x, y, box };
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('drawn')));
  setHeader(d, null);
}
function setHeader(d, i) {
  const { pts } = d.chart; const first = pts[0].v;
  const v = i == null ? (d.range === '1D' ? MK.price : pts.at(-1).v) : pts[i].v;
  const ch = i == null && d.range === '1D' ? MK.change : v - first;
  const pct = i == null && d.range === '1D' ? MK.pct : (ch / first) * 100;
  const when = i == null ? (d.range === '1D' ? 'Past day' : 'Past week') : new Date(pts[i].t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('[data-tprice]', d.scr).textContent = usd(v);
  const c = $('[data-tchg]', d.scr);
  c.className = `t-chg ${ch < 0 ? 'down' : 'up'}`;
  c.innerHTML = `<span>${ch < 0 ? '-' : '+'}${usd(Math.abs(ch))}</span><b>${pct < 0 ? '' : '+'}${pct.toFixed(2)}%</b><em>${when}</em>`;
}
function scrubAt(d, f) {
  const { pts, x, y, box } = d.chart; const i = Math.round(f * (pts.length - 1));
  box.classList.add('scrubbing');
  $('line.scrub', box).setAttribute('x1', x(i)); $('line.scrub', box).setAttribute('x2', x(i));
  $('circle.scrub', box).setAttribute('cx', x(i)); $('circle.scrub', box).setAttribute('cy', y(pts[i].v));
  setHeader(d, i);
}

// --- The engine: one phone (or the Chrome window), its screens, and presses --------------------------------------
const BROWSER = `<div class="b-bar"><span class="b-dots"><i></i><i></i><i></i></span><span class="b-url">shop.example/checkout</span><span class="b-ext" data-ext><img src="art/w-sky.png" alt=""></span></div>
  <div class="b-page"><div><h4>Merino scarf</h4><p>Undyed merino, knitted in small batches. Ships in plain packaging.</p><div class="b-item"></div></div>
  <div class="b-sum"><div><span>Scarf</span><b>$24.00</b></div><div><span>Shipping</span><b>Free</b></div><div><span>Total</span><b>0.0489 XMR</b></div><div class="b-pay" data-hit="pay" data-paybtn>Pay with Monero</div></div></div>
  <div class="b-pop"></div><i class="finger"></i>`;

class Demo {
  constructor(el) {
    this.el = el; this.name = el.dataset.demo;
    if (el.classList.contains('browser')) { el.innerHTML = BROWSER; this.app = el; this.host = $('.b-pop', el); }
    else {
      el.innerHTML = `<div class="app"><div class="p-status"><b>9:41</b><span class="sig"><i></i><i></i><i></i><i></i></span></div><div class="p-banner">Test network. These coins have no value.</div><div class="p-wipe"></div><i class="finger"></i></div>`;
      this.app = $('.app', el); this.host = this.app;
    }
    this.finger = $('.finger', this.app); this.wiper = $('.p-wipe', this.app);
    this.visible = false; this.running = false; this.state = {}; this.range = '1D';
  }
  q(s) { return $(s, this.app); }
  async wait(ms) { await sleep(ms); while (!this.visible) await sleep(200); }
  show(name, how) {
    const box = document.createElement('div'); box.innerHTML = SCREENS[name](this).trim();
    const scr = box.firstElementChild;
    if (how) scr.classList.add(`in-${how}`);
    const old = $(':scope > .scr', this.host);
    if (old) old.replaceWith(scr); else this.host.prepend(scr);
    this.scr = scr; this.screen = name;
    this.app.classList.toggle('sky-top', scr.classList.contains('sky'));
    SETUP[name]?.(this, scr);
    return scr;
  }
  // The app's own screen change: a slanted sky (or black) wipe crosses the screen.
  async go(name, tone) {
    this.wiper.classList.toggle('black', tone === 'black');
    this.wiper.classList.remove('go'); void this.wiper.offsetWidth; this.wiper.classList.add('go');
    await sleep(290); this.show(name); await this.wait(360);
  }
  async push(name) { this.show(name, 'push'); await this.wait(340); }
  async back(name) { this.show(name, 'back'); await this.wait(340); }
  // Our "something leaves the phone" moment: the Monero coin winds up, lifts out past the frame, spinning, and goes.
  coin(el, { out = true, dx = 380, dy = -40 } = {}) {
    const stage = this.el.parentElement; const s = stage.getBoundingClientRect(); const r = el.getBoundingClientRect();
    const img = new Image(); img.src = 'app/xmr.png'; img.className = 'coin-fly'; img.alt = '';
    img.style.left = `${r.left + r.width / 2 - s.left - 30}px`; img.style.top = `${r.top + r.height / 2 - s.top - 30}px`;
    stage.append(img);
    const at = (x, y, sc, ry) => `translate(${x}px, ${y}px) scale(${sc}) rotateY(${ry}deg)`;
    const frames = out
      ? [{ transform: at(0, 0, 1, 0), opacity: 0 }, { transform: at(0, 10, .82, 0), opacity: 1, offset: .14, easing: 'cubic-bezier(.36, 0, .66, -.56)' },
        { transform: at(dx * .5, dy * .5 - 110, 2.6, 360), opacity: 1, offset: .62, easing: 'cubic-bezier(.33, 1, .68, 1)' }, { transform: at(dx, dy, 1.15, 720), opacity: 0 }]
      : [{ transform: at(dx, dy, 2.2, 720), opacity: 0 }, { transform: at(dx * .45, dy * .55 - 70, 2.6, 360), opacity: 1, offset: .4, easing: 'cubic-bezier(.33, 1, .68, 1)' },
        { transform: at(0, 0, .9, 0), opacity: 1, offset: .88, easing: 'cubic-bezier(.5, 0, .75, 0)' }, { transform: at(0, 0, .4, 0), opacity: 0 }];
    const anim = img.animate(frames, { duration: calm ? 1 : 1250, fill: 'forwards' });
    anim.finished.then(() => img.remove(), () => img.remove());
    return anim.finished.catch(() => {});
  }
  point(t, fx = .5, fy = .5) {
    const a = this.app.getBoundingClientRect(); const r = t.getBoundingClientRect(); const k = a.width / this.app.offsetWidth;
    return [(r.left + r.width * fx - a.left) / k, (r.top + r.height * fy - a.top) / k];
  }
  // A press: a beat to read, the ripple where the thumb lands, the button gives a little.
  async tap(sel, then) {
    const t = typeof sel === 'string' ? this.q(sel) : sel;
    if (!t) return;
    await this.wait(300);
    const [x, y] = this.point(t);
    this.finger.style.transform = `translate(${x}px, ${y}px)`;
    this.finger.classList.remove('tap'); void this.finger.offsetWidth; this.finger.classList.add('tap');
    t.classList.add('pressing');
    await sleep(170);
    t.classList.remove('pressing');
    if (then) then(t);
    await this.wait(140);
  }
  async drag(sel, from, to, ms, step) {
    const t = this.q(sel); if (!t) return;
    await this.wait(380);
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const f = from + ((to - from) * i) / N;
      const [x, y] = this.point(t, f, .5);
      this.finger.style.transform = `translate(${x}px, ${y}px)`;
      this.finger.style.animation = 'none'; this.finger.style.opacity = '1';
      step?.(f, t);
      await sleep(ms / N);
    }
    this.finger.style.animation = ''; this.finger.style.opacity = '';
  }
  reset() { this.state = { hidden: false, test: false }; this.app.classList.remove('test'); this.range = '1D'; this.rollIn = false; this.added = false; this.testBal = '0.0000'; }
  async run() {
    if (this.running) return; this.running = true;
    for (;;) { await this.wait(0); this.reset(); try { await SCRIPTS[this.name](this); } catch (e) { console.warn('demo', this.name, e); await sleep(1000); } }
  }
}
const slideTo = (f, t) => { const fill = $('.fill', t); fill.style.transition = 'none'; fill.style.transform = `translateX(calc((64px - 100%) * ${1 - f}))`; };
const finishSlide = (t) => { const fill = $('.fill', t); fill.style.transition = ''; fill.style.transform = ''; t.classList.add('done'); };

// --- What each phone does, on a loop while it's on screen ---------------------------------------------------------
const SCRIPTS = {
  // Hero: unlock, the balance rolls in, a look at Activity, back to the wallet.
  async open(d) {
    d.show('lock'); await d.wait(700);
    await d.tap('[data-pw]');
    const pw = d.q('[data-pw]'); pw.innerHTML = '';
    for (let i = 0; i < 10; i++) { pw.insertAdjacentHTML('beforeend', '<i></i>'); await d.wait(55); }
    await d.tap('[data-hit=unlock]');
    d.rollIn = true; await d.go('home'); d.rollIn = false;
    await d.wait(2400);
    await d.tap('[data-hit=tab-activity]'); d.show('activity', 'fade'); await d.wait(2000);
    await d.tap('[data-hit=tab-home]'); d.show('home', 'fade'); await d.wait(2000);
  },
  // Monero: open its screen, the chart draws, a thumb drags along it, switch to the week.
  async token(d) {
    d.show('home'); await d.wait(800);
    await d.tap('[data-hit=monero]'); await d.push('token'); await d.wait(1100);
    await d.drag('[data-chart]', .12, .9, 1700, (f) => scrubAt(d, f));
    d.chart.box.classList.remove('scrubbing'); setHeader(d, null); await d.wait(500);
    await d.tap('[data-hit=r-1W]', (t) => { $$('.t-ranges span', d.scr).forEach((s) => s.classList.remove('on')); t.classList.add('on'); d.range = '1W'; drawChart(d); });
    await d.wait(1700);
    await d.tap('[data-hit=back]'); await d.back('home'); await d.wait(700);
  },
  // Send: type 0.50 on the keypad, pick @kestrel, slide, the coin leaves, Sending, Sent, Done.
  async send(d) {
    d.show('home'); await d.wait(700);
    await d.tap('[data-hit=send]'); await d.go('send'); await d.wait(300);
    const amt = d.q('[data-amt]'); let typed = '';
    for (const k of ['0', '.', '5', '0']) await d.tap(`[data-key="${k}"]`, () => { typed += k; amt.textContent = typed; });
    d.q('[data-fee]').textContent = 'Fee about 0.00003 XMR';
    d.q('[data-amtchip]').classList.add('hit');
    await d.tap('[data-hit=n-kestrel]', () => { d.q('[data-name]').textContent = 'kestrel'; d.q('[data-namechip]').classList.add('hit'); d.q('[data-names]').style.visibility = 'hidden'; });
    await d.wait(250);
    await d.drag('[data-slide]', .1, .97, 650, slideTo); finishSlide(d.q('[data-slide]'));
    const coin = d.coin($('img', d.q('[data-amtchip]')));
    d.q('.s-pad').outerHTML = `<div class="s-sending"><div class="lbl">Sending</div><div class="sbars">${Array.from({ length: 22 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div></div>`;
    await coin; await d.go('sent'); await d.wait(2000);
    await d.tap('[data-hit=done]'); await d.go('home', 'black'); await d.wait(800);
  },
  // Activity: open a payment, copy its ID, the XMRScan button, back.
  async tx(d) {
    d.show('activity'); await d.wait(800);
    await d.tap('[data-hit=tx0]'); await d.push('tx'); await d.wait(1000);
    await d.tap('[data-hit=copyid]', (t) => { t.innerHTML = `Copied ${ic('check')}`; });
    await d.wait(800);
    d.q('[data-status]').textContent = '4 of 10 checks';
    await d.tap('[data-hit=xmrscan]'); await d.wait(1000);
    await d.tap('[data-hit=back]'); await d.back('activity'); await d.wait(700);
  },
  // Receive: a fresh address, copy it, and a payment lands: the coin flies in and the balance rolls up.
  async receive(d) {
    d.show('home'); await d.wait(700);
    await d.tap('[data-hit=receive]'); await d.go('receive'); await d.wait(1000);
    await d.tap('[data-hit=copy]', (t) => { $('b', t).innerHTML = `Copied ${ic('check')}`; });
    await d.wait(900);
    await d.tap('[data-hit=back]'); await d.go('home'); await d.wait(500);
    await d.coin(d.q('[data-bal]'), { out: false, dx: 300, dy: -230 });
    roll(d.q('[data-bal]'), '5.3210'); $('[data-amt-hide]', d.scr).textContent = '5.3210';
    d.q('[data-hit=monero]').classList.add('pulse'); d.q('[data-sync]').textContent = '0.5000 on the way';
    await d.wait(2400);
  },
  // Hide: tap the balance, everything turns to stars; tap again, it rolls back.
  async hide(d) {
    d.show('home'); await d.wait(1100);
    await d.tap('[data-hit=bal]', () => { d.state.hidden = true; d.show('home'); });
    await d.wait(1900);
    await d.tap('[data-hit=bal]', () => { d.state.hidden = false; d.rollIn = 'digits'; d.show('home'); d.rollIn = false; });
    await d.wait(1900);
  },
  // Names: add @kestrel from a pasted address.
  async names(d) {
    d.show('home'); await d.wait(700);
    await d.tap('[data-hit=tab-names]'); d.show('names', 'fade'); await d.wait(900);
    await d.tap('[data-hit=addname]'); await d.push('nameadd'); await d.wait(250);
    await d.tap('[data-hit=nbox]', (t) => { t.textContent = ADDR; });
    await d.tap('[data-hit=nchip]');
    const nm = d.q('[data-nname]'); nm.textContent = '';
    for (const c of 'kestrel') { nm.textContent += c; await d.wait(85); }
    d.q('[data-nchip]').classList.add('hit');
    await d.tap('[data-hit=save]', () => { d.added = true; });
    await d.back('names'); d.q('.a-slip').classList.add('pulse'); await d.wait(2000);
  },
  // Face ID: it scans, it's you, the wallet opens.
  async faceid(d) {
    d.show('faceid'); await d.wait(700);
    const f = d.q('[data-fid]'); f.classList.add('scan'); await d.wait(2200);
    f.classList.remove('scan'); f.classList.add('ok-face'); f.innerHTML = ic('check'); d.q('[data-fidw]').textContent = 'Unlocked';
    await d.wait(500);
    d.rollIn = true; await d.go('home'); d.rollIn = false; await d.wait(2600);
  },
  // Test network: Developer settings, switch it on, the app restarts on test coins, the faucet pays out.
  async testnet(d) {
    d.show('home'); await d.wait(700);
    await d.tap('[data-hit=tab-settings]'); d.show('settings', 'fade'); await d.wait(800);
    await d.tap('[data-hit=dev]'); await d.push('developer'); await d.wait(650);
    await d.tap('[data-hit=tn]', (t) => t.classList.add('on')); await d.wait(450);
    d.state.test = true; d.app.classList.add('test'); d.testBal = '0.0000';
    await d.go('home'); await d.wait(800);
    await d.tap('[data-hit=faucet]', () => { d.q('[data-fct]').textContent = 'Asking the faucet'; });
    await d.wait(800);
    d.q('[data-fct]').textContent = 'On its way'; d.q('[data-fcs]').textContent = '0.01 test XMR. It shows up in a minute or two.';
    await d.coin(d.q('[data-bal]'), { out: false, dx: -300, dy: -220 });
    d.testBal = '0.0100'; roll(d.q('[data-bal]'), '0.0100'); $('[data-amt-hide]', d.scr).textContent = '0.0100';
    d.q('[data-hit=monero]').classList.add('pulse');
    await d.wait(2200);
  },
  // Chrome: a shop asks for Monero, Walnero opens with it filled in, slide, the coin crosses to the shop, paid.
  async web(d) {
    d.host.classList.remove('open'); d.q('[data-ext]').classList.remove('lit'); d.q('[data-paybtn]').textContent = 'Pay with Monero';
    await d.wait(900);
    await d.tap('[data-hit=pay]');
    d.q('[data-ext]').classList.add('lit'); d.show('pay'); d.host.classList.add('open');
    await d.wait(1300);
    await d.drag('[data-slide]', .1, .97, 650, slideTo); finishSlide(d.q('[data-slide]'));
    await d.wait(250); d.show('paid', 'fade'); await d.wait(1000);
    d.host.classList.remove('open'); await d.wait(250);
    // The payment travels from Walnero, up in the toolbar, into the shop's button.
    const ext = d.q('[data-ext]'); const pay = d.q('[data-paybtn]');
    const a = ext.getBoundingClientRect(); const b = pay.getBoundingClientRect();
    await d.coin(ext, { dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2) });
    ext.classList.remove('lit'); pay.textContent = 'Paid. Thank you'; pay.classList.add('pulse');
    await d.wait(2000); pay.classList.remove('pulse');
  },
};

const demos = $$('[data-demo]').map((el) => new Demo(el));
for (const d of demos) {
  new IntersectionObserver(([e]) => { d.visible = e.isIntersecting; if (d.visible) d.run(); }, { threshold: 0.3 }).observe(d.el);
}

// The Chrome window scales down to fit narrow screens.
function fitBrowsers() {
  for (const b of $$('.browser')) {
    const stage = b.parentElement; const s = Math.min(1, stage.clientWidth / 880);
    b.style.transform = `scale(${s})`; b.style.left = `${Math.max(0, (stage.clientWidth - 880 * s) / 2)}px`; stage.style.height = `${520 * s}px`;
  }
}
addEventListener('resize', fitBrowsers);
fitBrowsers();

// --- Bands, reveals, numbers ---------------------------------------------------------------------------------------
const TAN20 = Math.tan((20 * Math.PI) / 180);
const cutBands = () => $$('.band-in').forEach((b) => b.style.setProperty('--cut', `${Math.min(b.offsetHeight * TAN20, innerWidth < 720 ? 36 : 260)}px`));
addEventListener('resize', cutBands);
cutBands();
const onView = (el, fn, threshold = 0.3) => new IntersectionObserver((entries, io) => { if (entries.some((e) => e.isIntersecting)) { fn(); io.disconnect(); } }, { threshold }).observe(el);
for (const f of $$('.feature')) onView(f, () => f.classList.add('seen'), 0.2);
for (const num of $$('.speed .stats .reel-num')) { makeReels(num, num.dataset.num); setZero(num); }
onView($('.speed'), async () => { for (const num of $$('.speed .stats .reel-num')) { roll(num, num.dataset.num); await sleep(calm ? 0 : 220); } });
onView($('[data-rows]'), () => $('[data-rows]').classList.add('dealt'));

// The live chain: real block numbers from public Monero servers.
const NODES = ['https://xmr-node.cakewallet.com:18081', 'https://monero.definitelynotafed.com', 'https://xmr.support:18089'];
const blockEl = $('[data-block]'); const noteEl = $('[data-block-note]');
let lastHeight = 0;
async function topBlock() {
  for (const node of NODES) {
    try {
      const r = await fetch(`${node}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block_count' }), signal: AbortSignal.timeout(6000) });
      const count = (await r.json())?.result?.count;
      if (count) return count - 1;
    } catch { /* next server */ }
  }
  return null;
}
async function tick() {
  const height = await topBlock();
  if (height == null) { if (!lastHeight) noteEl.textContent = "can't reach the network right now"; return; }
  if (height === lastHeight) return;
  liveBlock = height;
  if (!lastHeight) { makeReels(blockEl, commas(height)); setZero(blockEl); await sleep(60); }
  roll(blockEl, commas(height));
  noteEl.textContent = lastHeight ? 'a new block just landed' : 'live, a new one about every 2 minutes';
  lastHeight = height;
}
makeReels(blockEl, '0,000,000');
tick(); setInterval(tick, 20000);

// Header gets its black once you scroll.
const header = $('.top');
const onScroll = () => header.style.setProperty('--head', String(Math.min(1, scrollY / 200) * .86));
addEventListener('scroll', onScroll, { passive: true });
onScroll();
