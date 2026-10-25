// Screenshot harness: runs the built Baton (out/main.js) against a FAKE HOME and captures pages.
//   npm run shots   (builds, makes a fake home in the temp dir, writes docs/screenshots/*.png)
// No claude CLI and no osascript are ever spawned from here; nothing is applied (previews are cancelled).
const path = require('path'), fs = require('fs'), os = require('os'), util = require('util');
const REPO = process.env.CS_REPO, FAKE = process.env.CS_FAKE_HOME, OUT = process.env.CS_OUT;
if (!FAKE || path.resolve(FAKE) === os.homedir() || !fs.existsSync(path.join(FAKE, '.baton', 'state.json'))) throw new Error('refusing: a fake home made by fixture.cjs is required');
process.env.HOME = FAKE;
const cp = require('node:child_process');
const orig = cp.execFile, origP = orig[util.promisify.custom];
const blocked = (f, a) => path.basename(String(f)) === 'claude' || String(f).endsWith('osascript') || (Array.isArray(a) && a.join(' ').includes('command -v claude'));
function execFile(f, a, o, cb) {
  if (blocked(f, a)) {
    const c = [a, o, cb].find((x) => typeof x === 'function');
    if (c) process.nextTick(() => c(new Error('blocked by screenshot harness'), '', ''));
    return { pid: 0, on() {}, once() {}, kill() {}, stdout: null, stderr: null };
  }
  return orig.apply(this, arguments);
}
execFile[util.promisify.custom] = (f, a, o) => (blocked(f, a) ? Promise.reject(new Error('blocked by screenshot harness')) : origP(f, a, o));
cp.execFile = execFile;
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(FAKE, '.electron-userdata'));
require(path.join(REPO, 'out', 'main.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  let win;
  const isMain = (w) => /index\.html$/.test(w.webContents.getURL());
  for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows().find(isMain)); i++) await sleep(100);
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  win.show();
  wc.setBackgroundThrottling(false); // keep painting while the window is behind other windows
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`);
  const click = (text, sel = 'button,summary') => js(`const t=${JSON.stringify(text)}; const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim().replace(/\\s+/g,' ').includes(t)); if(!el) throw new Error('no element: '+t); el.click(); return true;`);
  const shot = async (name, w = 1180, h = 760) => {
    win.setContentSize(w, h);
    await sleep(500);
    // the fake home lives in the temp dir; show it as a plain /Users/alex in the pictures
    await js(`const f=${JSON.stringify(fs.realpathSync(FAKE))}, g=${JSON.stringify(FAKE)}; const tw=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while((n=tw.nextNode())) if(n.nodeValue.includes(f)||n.nodeValue.includes(g)) n.nodeValue=n.nodeValue.split(f).join('/Users/alex').split(g).join('/Users/alex'); return 1`);
    wc.invalidate(); // force a fresh frame (capturePage can return the last painted one)
    await sleep(400);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('saved', name, img.getSize());
  };
  // vibrancy does not show in capturePage: paint the sidebar like macOS does in light mode
  await wc.insertCSS('aside { background: #ecebe8 !important; }');
  try {
    await sleep(1500);
    await click('Accounts', 'nav button');
    await sleep(1500);
    await shot('01-accounts.png', 1180, 1020);
    await click('Merge & tidy up');
    await sleep(500);
    await shot('02-merge-choose.png', 1180, 760);
    await click('Review changes');
    await sleep(2500);
    await shot('03-merge-preview.png', 1180, 900);
    await click('Cancel');
    await sleep(400);
    await js(`document.querySelector('details')?.setAttribute('open',''); return 1`);
    await sleep(300);
    await js(`document.querySelector('main .overflow-y-auto').scrollTop = 99999; return 1`);
    await shot('04-accounts-advanced.png', 1180, 760);
    await click('Shared projects', 'nav button');
    await sleep(1500);
    await click('Change…');
    await sleep(800);
    await shot('05-share-modal.png', 1180, 760);
    await js(`document.querySelector('[role=dialog] details').setAttribute('open',''); return 1`);
    await sleep(300);
    win.setContentSize(1180, 600);
    await sleep(500);
    await js(`const b=document.querySelector('[data-dialog-body]'); b.scrollTop=b.scrollHeight; return 1`);
    await shot('06-share-modal-small-scrolled.png', 1180, 600);
    const info = await js(`const d=document.querySelector('[role=dialog]').getBoundingClientRect(); const f=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('Review changes')).getBoundingClientRect(); return {dialogBottom:d.bottom, footerButtonBottom:f.bottom, vh: innerHeight}`);
    console.log('footer check at 600px:', JSON.stringify(info));
    await click('Review changes');
    await sleep(2500);
    await shot('07-share-preview.png', 1180, 760);
    for (let k = 0; k < 4; k++) {
      const n = await js(`const d=[...document.querySelectorAll('[role=dialog]')]; const c=[...(d.pop()?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()==='Cancel'); c?.click(); return d.length + (c?1:0)`);
      await sleep(400);
      if (!n) break;
    }
    await click('Sessions', 'nav button');
    await sleep(1500);
    await shot('08-sessions.png', 1180, 760);
    wc.send('route', 'onboarding');
    await sleep(500);
    await click('Next');
    await sleep(300);
    await shot('12-onboarding-fair-use.png', 1180, 760);
    await click('These accounts are mine', 'label');
    await sleep(200);
    await click('Next');
    await sleep(300);
    await shot('09-intro-desktop-app.png', 1180, 760);
    wc.send('route', 'fairuse');
    await sleep(300);
    await js(`document.querySelector('[role=dialog] button[aria-label=Close]')?.click(); return 1`);
    await sleep(300);
    await click('Fair use', 'nav button');
    await sleep(800);
    await shot('10-fair-use.png', 1180, 1000);
    wc.send('route', 'add');
    await sleep(500);
    await click('Personal', '[role=radio]');
    await sleep(300);
    await js(`const b=document.querySelector('[data-dialog-body]'); b.scrollTop=b.scrollHeight; return 1`);
    await sleep(300);
    await shot('11-second-personal-plan.png', 1180, 940);
    await trayShots();
  } catch (e) {
    console.error('SHOOT FAILED', e);
    await shot('error.png').catch(() => {});
  }
  app.exit(0);
});

// The menu-bar popover, dark and light. Shown inactive (no focus, so it doesn't hide on blur) at a fixed spot;
// vibrancy doesn't show in capturePage, so the glass is painted nearly opaque for the pictures.
async function trayShots() {
  const { nativeTheme } = require('electron');
  // "Work is active in this project": a lock held by a live pid (this harness) — only inside the fake home
  fs.writeFileSync(path.join(FAKE, '.baton', 'active.json'), JSON.stringify({ account: 'work', project: path.join(FAKE, 'Projects', 'acme-web'), pid: process.pid, since: new Date().toISOString() }));
  let pw;
  for (let i = 0; i < 100 && !(pw = BrowserWindow.getAllWindows().find((w) => /tray\.html$/.test(w.webContents.getURL()))); i++) await sleep(100);
  if (!pw) throw new Error('no tray popover window');
  const pc = pw.webContents;
  await new Promise((r) => (pc.isLoading() ? pc.once('did-finish-load', r) : r()));
  pc.setBackgroundThrottling(false);
  await pc.insertCSS('.tray-body{--t-glass:rgba(248,248,246,.985)!important} @media (prefers-color-scheme: dark){.tray-body{--t-glass:rgba(19,22,24,.985)!important}}');
  const pjs = (code) => pc.executeJavaScript(`(async () => { ${code} })()`);
  for (const [theme, name] of [['dark', '13-tray-dark.png'], ['light', '14-tray-light.png']]) {
    nativeTheme.themeSource = theme;
    pw.setPosition(900, 40);
    pw.showInactive();
    pc.send('trayShown', { reduceMotion: true });
    await sleep(1500);
    await pjs(`const f=${JSON.stringify(fs.realpathSync(FAKE))}, g=${JSON.stringify(FAKE)}; const tw=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while((n=tw.nextNode())) if(n.nodeValue.includes(f)||n.nodeValue.includes(g)) n.nodeValue=n.nodeValue.split(f).join('/Users/alex').split(g).join('/Users/alex'); document.querySelectorAll('[title]').forEach(e=>e.title=e.title.split(f).join('/Users/alex').split(g).join('/Users/alex')); return 1`);
    pc.invalidate();
    await sleep(400);
    const img = await pc.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('saved', name, img.getSize());
  }
  pw.hide();
  fs.rmSync(path.join(FAKE, '.baton', 'active.json'), { force: true });
}
