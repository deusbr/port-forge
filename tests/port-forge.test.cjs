'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const {
  inspectTarget,
  inspectPeBuffer,
  inspectXexBuffer,
  recommendRuntime,
  generateScaffold,
  diagnoseLogText,
  probeAdb,
  ForgeStore,
  createWebServer,
  installToClients
} = require('../index.cjs');
const { TOOLS, handleMessage } = require('../bin/mcp-server.cjs');

function makeTempDir(prefix = 'port-forge-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildMinimalPe({ machine = 0x8664, pe32Plus = true, dlls = ['d3d11.dll', 'UnityPlayer.dll'] } = {}) {
  // Layout:
  // 0x000..0x040: DOS header (e_lfanew = 0x80)
  // 0x080..0x188: PE signature + COFF + OptionalHeader + 1 SectionHeader (.rdata at raw 0x200, RVA 0x2000)
  // 0x200..0x400: Import descriptors + ASCII DLL names
  const buf = Buffer.alloc(0x500, 0);
  buf.writeUInt16LE(0x5a4d, 0); // MZ
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew

  const peOff = 0x80;
  buf.writeUInt32LE(0x00004550, peOff); // PE\0\0
  const coffOff = peOff + 4;
  buf.writeUInt16LE(machine, coffOff);
  buf.writeUInt16LE(1, coffOff + 2); // 1 section
  const optSize = pe32Plus ? 240 : 224;
  buf.writeUInt16LE(optSize, coffOff + 16);
  buf.writeUInt16LE(0x0002, coffOff + 18); // executable image

  const optOff = coffOff + 20;
  buf.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optOff);
  buf.writeUInt16LE(2, optOff + 68); // Windows GUI
  const numRvaOff = optOff + (pe32Plus ? 108 : 92);
  buf.writeUInt32LE(16, numRvaOff);

  const dataDirOff = optOff + (pe32Plus ? 112 : 96);
  // Import Directory entry = DataDirectory[1] -> RVA 0x2000
  buf.writeUInt32LE(0x2000, dataDirOff + 8);
  buf.writeUInt32LE(0x100, dataDirOff + 12);

  // Section header .rdata immediately after OptionalHeader
  const secOff = optOff + optSize;
  buf.write('.rdata\0\0', secOff, 'ascii');
  buf.writeUInt32LE(0x300, secOff + 8); // virtualSize
  buf.writeUInt32LE(0x2000, secOff + 12); // virtualAddress
  buf.writeUInt32LE(0x300, secOff + 16); // sizeOfRawData
  buf.writeUInt32LE(0x200, secOff + 20); // pointerToRawData

  // Write Import descriptors starting at 0x200 (RVA 0x2000)
  // Names start at 0x300 (RVA 0x2100)
  let nameCursor = 0x300;
  dlls.forEach((dll, idx) => {
    const descOff = 0x200 + idx * 20;
    const nameRva = 0x2000 + (nameCursor - 0x200);
    buf.writeUInt32LE(0x2000, descOff); // non-zero OriginalFirstThunk
    buf.writeUInt32LE(nameRva, descOff + 12);
    buf.write(`${dll}\0`, nameCursor, 'ascii');
    nameCursor += dll.length + 1;
  });

  return buf;
}

function buildMinimalXex(titleId = 0x4d5307e6) {
  const buf = Buffer.alloc(128, 0);
  buf.write('XEX2', 0, 'ascii');
  buf.writeUInt32BE(0x00000001, 4); // moduleFlags
  buf.writeUInt32BE(0x80, 8); // peDataOffset
  buf.writeUInt32BE(0x40, 16); // securityInfoOffset
  buf.writeUInt32BE(2, 20); // headerCount = 2

  // Optional header 0: Entry point (0x00010100)
  buf.writeUInt32BE(0x00010100, 24);
  buf.writeUInt32BE(0x82000000, 28);

  // Optional header 1: Execution info (0x00040006) pointing to offset 64
  buf.writeUInt32BE(0x00040006, 32);
  buf.writeUInt32BE(64, 36);

  buf.writeUInt32BE(0x11223344, 64); // mediaId
  buf.writeUInt32BE(titleId, 64 + 12); // titleId
  return buf;
}

test('inspectPeBuffer detects PE32+, Direct3D 11, UnityPlayer, and XInput', () => {
  const buf = buildMinimalPe({
    machine: 0x8664,
    pe32Plus: true,
    dlls: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll', 'UnityPlayer.dll', 'xinput1_4.dll']
  });
  const res = inspectPeBuffer(buf, 'SampleGame.exe');
  assert.equal(res.kind, 'binary-pe');
  assert.equal(res.format, 'PE32+ (64-bit Windows)');
  assert.ok(res.graphicsApis.includes('Direct3D 11'));
  assert.ok(res.engines.includes('Unity'));
  assert.ok(res.inputApis.includes('XInput'));
  assert.equal(res.recommendedStrategy, 'winlator-translation');
});

test('inspectPeBuffer flags kernel anti-cheat and 32-bit WoW64', () => {
  const buf = buildMinimalPe({
    machine: 0x014c,
    pe32Plus: false,
    dlls: ['d3d9.dll', 'EasyAntiCheat_x86.dll']
  });
  const res = inspectPeBuffer(buf, 'Legacy32.exe');
  assert.equal(res.format, 'PE32 (32-bit Windows)');
  assert.equal(res.recommendedStrategy, 'blocked-kernel-anticheat');
  assert.ok(res.blockers.some((b) => b.code === 'KERNEL_ANTICHEAT'));
  assert.ok(res.blockers.some((b) => b.code === 'WOW64_32BIT'));
});

test('inspectXexBuffer parses Xbox 360 XEX2 titleId and XenonRecomp blockers', () => {
  const buf = buildMinimalXex(0x4d5307e6);
  const res = inspectXexBuffer(buf, 'default.xex');
  assert.equal(res.kind, 'binary-xex2');
  assert.equal(res.executionInfo.titleId, '0x4d5307e6');
  assert.equal(res.entryPoint, '0x82000000');
  assert.equal(res.recommendedStrategy, 'xenon-recomp-arm64');
  assert.ok(res.blockers.some((b) => b.code === 'BIG_ENDIAN_PPC'));
});

test('inspectTarget detects C++/Win32/DX and Electron source projects', () => {
  const tmp = makeTempDir();
  try {
    const cppDir = path.join(tmp, 'cpp-game');
    fs.mkdirSync(cppDir, { recursive: true });
    fs.writeFileSync(path.join(cppDir, 'CMakeLists.txt'), 'project(Game)\n');
    fs.writeFileSync(
      path.join(cppDir, 'main.cpp'),
      '#include <windows.h>\n#include <d3d11.h>\n#include <xinput.h>\nHWND hwnd;\n'
    );
    const cppRes = inspectTarget(cppDir);
    assert.equal(cppRes.stack, 'cpp-win32-dx');
    assert.equal(cppRes.recommendedStrategy, 'android-ndk-sdl2');
    assert.ok(cppRes.graphicsApis.includes('Direct3D 11'));

    const elecDir = path.join(tmp, 'electron-app');
    fs.mkdirSync(elecDir, { recursive: true });
    fs.writeFileSync(
      path.join(elecDir, 'package.json'),
      JSON.stringify({ name: 'desktop', devDependencies: { electron: '^30.0.0' } })
    );
    fs.writeFileSync(path.join(elecDir, 'main.js'), "const fs = require('node:fs');\n");
    const elecRes = inspectTarget(elecDir);
    assert.equal(elecRes.stack, 'electron');
    assert.equal(elecRes.recommendedStrategy, 'capacitor-android');
    assert.ok(elecRes.blockers.some((b) => b.code === 'NODE_DESKTOP_APIS'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('recommendRuntime enforces SoC rules for Adreno 6xx, Adreno 7xx Unity, and Mali', () => {
  const unityInspection = inspectPeBuffer(
    buildMinimalPe({ dlls: ['d3d11.dll', 'UnityPlayer.dll'] }),
    'UnityTitle.exe'
  );

  const adreno6xx = recommendRuntime({ inspection: unityInspection, soc: 'adreno-6xx', goal: 'balanced' });
  assert.ok(adreno6xx.launchArgs.includes('-force-gfx-direct'));
  assert.equal(adreno6xx.env.BOX64_DYNAREC_STRONGMEM, '1');
  assert.ok(adreno6xx.warnings.some((w) => w.includes('2.4.1')));

  const mali = recommendRuntime({ inspection: unityInspection, soc: 'mali-immortalis', goal: 'battery' });
  assert.equal(mali.socProfile.supportsTurnip, false);
  assert.ok(mali.dxvkConf.includes('dxvk.numCompilerThreads = 1'));
});

test('generateScaffold creates clean NDK/SDL2, XenonRecomp, and Winlator projects', () => {
  const tmp = makeTempDir();
  try {
    const ndkOut = path.join(tmp, 'ndk-out');
    const ndkRes = generateScaffold({ strategy: 'android-ndk-sdl2', outputDir: ndkOut, appName: 'StarPort' });
    assert.ok(ndkRes.writtenFiles.includes('CMakeLists.txt'));
    assert.ok(ndkRes.writtenFiles.includes('src/platform_bridge.hpp'));
    assert.ok(fs.existsSync(path.join(ndkOut, 'app/src/main/AndroidManifest.xml')));

    const recompOut = path.join(tmp, 'recomp-out');
    const recompRes = generateScaffold({ strategy: 'xenon-recomp-arm64', outputDir: recompOut, appName: 'XenonSample' });
    assert.ok(recompRes.writtenFiles.includes('include/xenon_android_shim.hpp'));
    assert.ok(fs.readFileSync(path.join(recompOut, 'PORTING_BLUEPRINT.md'), 'utf8').includes('Endianness'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diagnoseLogText detects Vulkan DeviceLost, Box64 Dynarec, NDK linker, and 16KB/mprotect issues', () => {
  const sampleLog = [
    '01-01 12:00:01 E/DXVK: VK_ERROR_DEVICE_LOST on vkWaitSemaphores',
    'BOX64: Warning: call to unaligned Dynarec error SIGILL',
    'ld.lld: error: undefined symbol: __android_log_print',
    'mprotect failed: EACCES Permission denied on 16 KB page'
  ].join('\n');

  const diag = diagnoseLogText(sampleLog);
  assert.equal(diag.matchCount, 4);
  const ids = diag.findings.map((f) => f.id);
  assert.ok(ids.includes('VK_DEVICE_LOST_TIMELINE'));
  assert.ok(ids.includes('BOX64_DYNAREC_FAULT'));
  assert.ok(ids.includes('NDK_LINKER_MISSING_LIB'));
  assert.ok(ids.includes('ANDROID_MPROTECT_OR_PAGE_ALIGN'));
});

test('probeAdb degrades cleanly without throwing when adb is absent', async () => {
  const res = await probeAdb({ adbBinary: 'nonexistent-adb-binary-xyz' });
  assert.equal(res.available, false);
  assert.ok(Array.isArray(res.devices));
});

test('ForgeStore persists, lists, and appends diagnoses', () => {
  const tmp = makeTempDir();
  try {
    const store = new ForgeStore(tmp);
    const created = store.createProject({
      name: 'DemoPort',
      targetPath: tmp,
      inspection: { kind: 'source-project', stack: 'cpp-win32-dx', recommendedStrategy: 'android-ndk-sdl2', readinessScore: 72 }
    });
    const list = store.listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);

    const updated = store.appendDiagnosis(created.id, { matchCount: 1 });
    assert.equal(updated.diagnoses.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP server exposes 8 tools and handles initialize & tools/call', async () => {
  assert.equal(TOOLS.length, 8);
  const origWrite = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'port_diagnose_log', arguments: { logText: 'VK_ERROR_DEVICE_LOST' } }
    });
  } finally {
    process.stdout.write = origWrite;
  }

  const parsed = captured.map((line) => JSON.parse(line.trim()));
  assert.equal(parsed[0].result.serverInfo.name, 'port-forge');
  assert.equal(parsed[1].result.tools.length, 8);
  const diagPayload = JSON.parse(parsed[2].result.content[0].text);
  assert.equal(diagPayload.diagnosis.findings[0].id, 'VK_DEVICE_LOST_TIMELINE');
});

test('Web workbench serves HTML and JSON APIs on localhost', async () => {
  const tmp = makeTempDir();
  const store = new ForgeStore(tmp);
  const web = createWebServer({ store, port: 0 });
  const info = await web.listen(0);
  try {
    const html = await new Promise((resolve, reject) => {
      http.get(info.url, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.ok(html.includes('Port-Forge Workbench'));

    const meta = await new Promise((resolve, reject) => {
      http.get(`${info.url}/api/meta`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.ok(meta.socs['adreno-7xx']);
    assert.ok(meta.strategies.includes('xenon-recomp-arm64'));
  } finally {
    await web.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('installToClients writes TOML, JSON, and SKILL.md cleanly in isolated home', () => {
  const tmp = makeTempDir();
  try {
    const res = installToClients({
      clients: ['codex', 'gemini', 'claude-code'],
      repoRoot: path.resolve(__dirname, '..'),
      envPaths: { home: tmp, appdata: path.join(tmp, 'appdata'), platform: 'win32' }
    });
    assert.equal(res.every((r) => r.ok), true);
    const codexToml = fs.readFileSync(path.join(tmp, '.codex', 'config.toml'), 'utf8');
    assert.ok(codexToml.includes('[mcp_servers.port-forge]'));
    const geminiJson = JSON.parse(fs.readFileSync(path.join(tmp, '.gemini', 'settings.json'), 'utf8'));
    assert.ok(geminiJson.mcpServers['port-forge']);
    assert.ok(fs.existsSync(path.join(tmp, '.gemini', 'skills', 'port-forge', 'SKILL.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
