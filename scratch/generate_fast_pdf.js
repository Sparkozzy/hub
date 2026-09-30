const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const htmlPath = path.resolve('apresentacao-institucional.html');
const pdfPath = path.resolve('apresentacao-institucional.pdf');
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const port = 9225;
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
  
  // Set exact 1920x1080 viewport
  await sendSession('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
  console.log('Navigating to:', fileUrl);
  await sendSession('Page.navigate', { url: fileUrl });

  console.log('Waiting 4s for fonts and animations...');
  await new Promise(r => setTimeout(r, 4000));

  // Hide navigation chrome
  await sendSession('Runtime.evaluate', {
    expression: `
      document.querySelector('.deck-header').style.display = 'none';
      document.querySelector('.deck-footer').style.display = 'none';
      const vp = document.getElementById('deck-viewport');
      vp.style.top = '0';
      vp.style.bottom = '0';
      vp.style.left = '0';
      vp.style.right = '0';
      vp.style.position = 'fixed';
    `
  });
  await new Promise(r => setTimeout(r, 300));

  // Capture each slide as a JPEG screenshot
  const images = [];
  const totalSlides = 14;

  for (let i = 0; i < totalSlides; i++) {
    console.log(`Capturando Slide ${i + 1}/${totalSlides}...`);
    await sendSession('Runtime.evaluate', {
      expression: `goToSlide(${i});`
    });
    await new Promise(r => setTimeout(r, 400));

    const shot = await sendSession('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }
    });
    images.push(Buffer.from(shot.result.data, 'base64'));
    console.log(`  Slide ${i + 1}: ${images[images.length - 1].length} bytes`);
  }

  ws.close();
  edgeProc.kill();

  console.log('\nMontando PDF com dimensões corretas (1920x1080pt)...');
  const pdf = buildPdf(images, 1920, 1080);
  fs.writeFileSync(pdfPath, pdf);
  const sizeMb = (pdf.length / 1024 / 1024).toFixed(2);
  console.log(`PDF gerado: ${pdf.length} bytes (${sizeMb} MB)`);
  console.log('Caminho:', pdfPath);
}

function buildPdf(jpegBuffers, widthPt, heightPt) {
  const chunks = [];
  const offsets = [];

  const writeStr = (s) => {
    const b = Buffer.from(s, 'binary');
    chunks.push(b);
    return b.length;
  };
  const writeBuf = (b) => {
    chunks.push(b);
    return b.length;
  };

  let pos = 0;
  const startObj = (id) => {
    offsets[id] = pos;
    const s = `${id} 0 obj\n`;
    pos += writeStr(s);
  };
  const endObj = () => {
    const s = `endobj\n`;
    pos += writeStr(s);
  };
  const write = (s) => { pos += writeStr(s); };
  const writeBin = (b) => { pos += writeBuf(b); };

  // Header
  pos += writeStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const n = jpegBuffers.length;
  // Object layout:
  // 1 = Catalog
  // 2 = Pages
  // For each slide i (0-based):
  //   3 + i*3 + 0 = Image XObject
  //   3 + i*3 + 1 = Content stream
  //   3 + i*3 + 2 = Page

  const imgId    = (i) => 3 + i * 3 + 0;
  const contId   = (i) => 3 + i * 3 + 1;
  const pageId   = (i) => 3 + i * 3 + 2;
  const totalObjs = 3 + n * 3; // 1-indexed, so highest id = totalObjs - 1

  // 1. Catalog
  startObj(1);
  write(`<< /Type /Catalog /Pages 2 0 R >>\n`);
  endObj();

  // 2. Pages
  const kids = Array.from({length: n}, (_, i) => `${pageId(i)} 0 R`).join(' ');
  startObj(2);
  write(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\n`);
  endObj();

  // Per-slide objects
  for (let i = 0; i < n; i++) {
    const jpg = jpegBuffers[i];

    // Image XObject
    startObj(imgId(i));
    write(`<< /Type /XObject /Subtype /Image /Width ${widthPt} /Height ${heightPt} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    writeBin(jpg);
    write(`\nendstream\n`);
    endObj();

    // Content stream: draw image filling page
    const stream = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im${i} Do Q\n`;
    startObj(contId(i));
    write(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream\n`);
    endObj();

    // Page
    startObj(pageId(i));
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents ${contId(i)} 0 R /Resources << /XObject << /Im${i} ${imgId(i)} 0 R >> >> >>\n`);
    endObj();
  }

  // Cross-reference table
  const xrefPos = pos;
  write(`xref\n0 ${totalObjs}\n`);
  write(`0000000000 65535 f \n`);
  for (let id = 1; id < totalObjs; id++) {
    const off = offsets[id] !== undefined ? offsets[id] : 0;
    write(String(off).padStart(10, '0') + ` 00000 n \n`);
  }
  write(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

run().catch(err => {
  console.error('Error:', err.stack || err);
  edgeProc.kill();
  process.exit(1);
});
