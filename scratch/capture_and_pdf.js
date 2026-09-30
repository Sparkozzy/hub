const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');


const htmlPath = path.resolve('apresentacao-institucional.html');
const slidesDir = path.resolve('scratch', 'slides_tmp');
const pdfPath = path.resolve('apresentacao-institucional.pdf');
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// Clean and recreate tmp dir
if (fs.existsSync(slidesDir)) fs.rmSync(slidesDir, { recursive: true });
fs.mkdirSync(slidesDir, { recursive: true });

const port = 9226;
const edgeProc = spawn(edgeExe, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${port}`,
  `--window-size=1920,1080`,
  'about:blank'
]);

async function run() {
  await new Promise(r => setTimeout(r, 2000));
  
  const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`);
  const versionInfo = await versionResp.json();
  const wsUrl = versionInfo.webSocketDebuggerUrl;
  console.log('Connected to Edge CDP:', wsUrl);
  
  const ws = new WebSocket(wsUrl);
  let idCounter = 1;
  const pending = new Map();
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = idCounter++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Target.setDiscoverTargets', { discover: true });

  const targetResp = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = targetResp.result.targetId;
  const attachResp = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attachResp.result.sessionId;

  function sendSession(method, params = {}) {
    return new Promise((resolve) => {
      const id = idCounter++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  }

  await sendSession('Page.enable');
  await sendSession('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
  console.log('Navigating to:', fileUrl);
  await sendSession('Page.navigate', { url: fileUrl });

  console.log('Waiting 4s for fonts and render...');
  await new Promise(r => setTimeout(r, 4000));

  // Hide navigation chrome and force viewport to fill exactly 1920x1080
  // CRITICAL: Disable ALL CSS transitions/animations so slides appear instantly
  await sendSession('Runtime.evaluate', {
    expression: `
      // Kill all CSS transitions and animations globally
      const noTransitionStyle = document.createElement('style');
      noTransitionStyle.innerHTML = \`
        html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: #0a0f1a !important; }
        *, *::before, *::after { transition: none !important; animation: none !important; animation-duration: 0s !important; transition-duration: 0s !important; }
      \`;
      document.head.appendChild(noTransitionStyle);

      document.querySelector('.deck-header').style.cssText = 'display:none!important';
      document.querySelector('.deck-footer').style.cssText = 'display:none!important';
      const vp = document.getElementById('deck-viewport');
      vp.style.cssText = 'position:fixed!important;top:0!important;bottom:0!important;left:0!important;right:0!important;width:1920px!important;height:1080px!important;overflow:hidden!important;margin:0!important';
    `
  });
  await new Promise(r => setTimeout(r, 200));

  const totalSlides = 14;
  const jpegPaths = [];

  for (let i = 0; i < totalSlides; i++) {
    console.log(`Capturando Slide ${i + 1}/${totalSlides}...`);
    await sendSession('Runtime.evaluate', { expression: `goToSlide(${i});` });
    // With transitions disabled, 150ms is enough for the DOM to settle
    await new Promise(r => setTimeout(r, 150));

    const shot = await sendSession('Page.captureScreenshot', {
      format: 'png',   // PNG = lossless, no JPEG artifacts on gradients
      clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }
    });

    const outPath = path.join(slidesDir, `slide_${String(i + 1).padStart(2, '0')}.png`);
    const imgBuf = Buffer.from(shot.result.data, 'base64');
    fs.writeFileSync(outPath, imgBuf);
    jpegPaths.push(outPath);
    console.log(`  Salvo: ${outPath} (${imgBuf.length} bytes)`);
  }

  ws.close();
  edgeProc.kill();

  console.log('\nMontando PDF via img2pdf (Python)...');
  execSync(`python scratch/assemble_pdf.py`, { cwd: path.resolve('.'), stdio: 'inherit' });
  console.log('Pronto!');
}

run().catch(err => {
  console.error('Error:', err.stack || err);
  edgeProc.kill();
  process.exit(1);
});
