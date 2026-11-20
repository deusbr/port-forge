'use strict';

const http = require('node:http');
const { inspectTarget } = require('./inspector.cjs');
const { recommendRuntime, SOC_PROFILES, RUNTIME_FORKS } = require('./winlator-oracle.cjs');
const { generateScaffold, STRATEGIES } = require('./scaffolder.cjs');
const { diagnoseLogText, probeAdb } = require('./log-doctor.cjs');
const { ForgeStore, defaultForgeHome } = require('./store.cjs');

const MAX_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function buildWorkbenchHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Port-Forge — Cross-Platform Porting Workbench</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #131a26;
    --border: #243044;
    --text: #e6edf7;
    --muted: #93a4be;
    --accent: #38bdf8;
    --ok: #34d399;
    --warn: #fbbf24;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 18px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .3px; }
  header span { color: var(--muted); font-size: 13px; }
  main { max-width: 1180px; margin: 24px auto; padding: 0 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  h2 { margin: 0 0 12px; font-size: 15px; color: var(--accent); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input, select, textarea { width: 100%; background: #0c121d; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: inherit; font-size: 13px; }
  textarea { min-height: 110px; font-family: ui-monospace, Consolas, monospace; }
  button { margin-top: 12px; background: var(--accent); color: #05111a; border: 0; border-radius: 6px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
  pre { background: #090d14; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 12px; overflow: auto; max-height: 280px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<header>
  <h1>Port-Forge Workbench</h1>
  <span>PC / Xbox 360 &rarr; Android (NDK, SDL2, Winlator, Box64, DXVK)</span>
</header>
<main>
  <section>
    <h2>1. Inspect Target (.exe, .xex, or Source Dir)</h2>
    <label for="targetPath">Local Target Path</label>
    <input id="targetPath" placeholder="C:\\path\\to\\game.exe or repo" />
    <label for="socSelect">Target Android SoC</label>
    <select id="socSelect"></select>
    <label for="runtimeSelect">Winlator Runtime</label>
    <select id="runtimeSelect"></select>
    <label for="goalSelect">Optimization Goal</label>
    <select id="goalSelect">
      <option value="balanced">Balanced</option>
      <option value="stability">Stability</option>
      <option value="fps">Max FPS</option>
      <option value="battery">Battery / Thermals</option>
    </select>
    <button id="inspectBtn">Inspect &amp; Generate Oracle Preset</button>
    <pre id="inspectOut">Waiting for target...</pre>
  </section>

  <section>
    <h2>2. Scaffold Android Project</h2>
    <label for="strategySelect">Porting Strategy</label>
    <select id="strategySelect"></select>
    <label for="appName">App Name</label>
    <input id="appName" value="PortedApp" />
    <label for="outDir">Output Directory</label>
    <input id="outDir" placeholder="C:\\path\\to\\output-scaffold" />
    <button id="scaffoldBtn">Generate Porting Scaffold</button>
    <pre id="scaffoldOut">Select strategy and output directory...</pre>
  </section>

  <section>
    <h2>3. Crash &amp; Build Log Doctor</h2>
    <label for="logText">Paste logcat / WINEDEBUG / Box64 / NDK CMake output</label>
    <textarea id="logText" placeholder="VK_ERROR_DEVICE_LOST / BOX64 SIGILL / undefined reference..."></textarea>
    <button id="diagnoseBtn">Diagnose Root Cause</button>
    <button id="adbBtn" style="margin-left:8px;background:#34d399;">Probe ADB Devices</button>
    <pre id="diagnoseOut">Ready for log analysis...</pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
async function callApi(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}
function fillSelect(el, items) {
  el.textContent = '';
  for (const [val, label] of items) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    el.appendChild(opt);
  }
}
(async () => {
  const meta = await callApi('/api/meta', 'GET');
  fillSelect($('socSelect'), Object.values(meta.socs).map((s) => [s.id, s.name]));
  fillSelect($('runtimeSelect'), Object.values(meta.runtimes).map((r) => [r.id, r.name]));
  fillSelect($('strategySelect'), meta.strategies.map((s) => [s, s]));
})();
$('inspectBtn').onclick = async () => {
  const data = await callApi('/api/inspect', 'POST', {
    targetPath: $('targetPath').value,
    soc: $('socSelect').value,
    runtime: $('runtimeSelect').value,
    goal: $('goalSelect').value
  });
  $('inspectOut').textContent = JSON.stringify(data, null, 2);
};
$('scaffoldBtn').onclick = async () => {
  const data = await callApi('/api/scaffold', 'POST', {
    strategy: $('strategySelect').value,
    appName: $('appName').value,
    outputDir: $('outDir').value,
    soc: $('socSelect').value,
    runtime: $('runtimeSelect').value,
    goal: $('goalSelect').value
  });
  $('scaffoldOut').textContent = JSON.stringify(data, null, 2);
};
$('diagnoseBtn').onclick = async () => {
  const data = await callApi('/api/diagnose', 'POST', { logText: $('logText').value });
  $('diagnoseOut').textContent = JSON.stringify(data, null, 2);
};
$('adbBtn').onclick = async () => {
  const data = await callApi('/api/adb', 'GET');
  $('diagnoseOut').textContent = JSON.stringify(data, null, 2);
};
</script>
</body>
</html>`;
}

function createWebServer({ store = new ForgeStore(defaultForgeHome()), port = 4380 } = {}) {
  const html = buildWorkbenchHtml();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return sendJson(res, 200, {
          socs: SOC_PROFILES,
          runtimes: RUNTIME_FORKS,
          strategies: STRATEGIES
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return sendJson(res, 200, { projects: store.listProjects() });
      }
      if (req.method === 'GET' && url.pathname === '/api/adb') {
        const adb = await probeAdb();
        return sendJson(res, 200, adb);
      }
      if (req.method === 'POST' && url.pathname === '/api/inspect') {
        const body = await readJsonBody(req);
        const inspection = inspectTarget(body.targetPath);
        const oracle = recommendRuntime({
          inspection,
          soc: body.soc || 'adreno-7xx',
          runtime: body.runtime || 'winlator-cmod',
          goal: body.goal || 'balanced'
        });
        const project = store.createProject({
          name: body.name,
          targetPath: body.targetPath,
          inspection,
          oracle
        });
        return sendJson(res, 200, { project, inspection, oracle });
      }
      if (req.method === 'POST' && url.pathname === '/api/scaffold') {
        const body = await readJsonBody(req);
        const result = generateScaffold({
          strategy: body.strategy,
          outputDir: body.outputDir,
          appName: body.appName,
          soc: body.soc,
          runtime: body.runtime,
          goal: body.goal,
          overwrite: Boolean(body.overwrite)
        });
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/diagnose') {
        const body = await readJsonBody(req);
        const diagnosis = diagnoseLogText(body.logText);
        return sendJson(res, 200, diagnosis);
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  return {
    server,
    listen(listenPort = port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', () => {
          const addr = server.address();
          resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = {
  createWebServer,
  buildWorkbenchHtml
};
