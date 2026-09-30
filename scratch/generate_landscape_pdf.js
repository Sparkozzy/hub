const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const htmlPath = path.resolve('apresentacao-institucional.html');
const pdfPath = path.resolve('apresentacao-institucional.pdf');
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const port = 9222;
const edgeProc = spawn(edgeExe, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${port}`,
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
  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
  console.log('Navigating to:', fileUrl);
  await sendSession('Page.navigate', { url: fileUrl });

  console.log('Waiting 3s for page render...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('Generating exact 16:9 landscape 1920x1080 PDF...');
  const pdfResult = await sendSession('Page.printToPDF', {
    landscape: false,     // Keep width=20in, height=11.25in without swapping!
    displayHeaderFooter: false,
    printBackground: true,
    paperWidth: 20,       // 1920px @ 96dpi = 20 in
    paperHeight: 11.25,   // 1080px @ 96dpi = 11.25 in
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    preferCSSPageSize: true,
    scale: 1.0
  });

  if (pdfResult.result && pdfResult.result.data) {
    const buffer = Buffer.from(pdfResult.result.data, 'base64');
    fs.writeFileSync(pdfPath, buffer);
    console.log(`PDF HORIZONTAL (16:9 LANDSCAPE) GERADO COM SUCESSO! Tamanho: ${buffer.length} bytes`);
  } else {
    console.error('Falha ao gerar PDF:', pdfResult);
  }

  ws.close();
  edgeProc.kill();
  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err);
  edgeProc.kill();
  process.exit(1);
});
