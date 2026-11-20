'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LOG_RULES = [
  {
    id: 'VK_DEVICE_LOST_TIMELINE',
    category: 'vulkan-dxvk',
    severity: 'critical',
    pattern: /VK_ERROR_DEVICE_LOST|timeline semaphore|vkWaitSemaphores|DxvkDevice.*lost/i,
    title: 'Vulkan Device Lost / Timeline Semaphore Hang',
    rootCause: 'Driver failed to satisfy VK_KHR_timeline_semaphore or hung a command buffer (common with DXVK > 2.4.1 on Adreno 6xx or non-Turnip drivers).',
    fixes: [
      'Pin DXVK to 2.4.1 (or 2.4.1-gplasync) instead of DXVK 2.5+.',
      'Set MESA_EXTENSION_MAX_YEAR=2024 when using Turnip.',
      'If running Direct3D 12 via vkd3d-proton, test forcing `-dx11` launch flag.'
    ]
  },
  {
    id: 'BOX64_DYNAREC_FAULT',
    category: 'cpu-translation',
    severity: 'high',
    pattern: /BOX64.*(SIGILL|SIGSEGV|Dynarec.*error|Warning: call to|unaligned)/i,
    title: 'Box64 Dynarec Memory Ordering or Flag Fault',
    rootCause: 'Aggressive Box64 dynarec optimizations (FASTNAN/BIGBLOCK/STRONGMEM=0) broke x86 flag or lock-free memory ordering.',
    fixes: [
      'Switch Box64 preset to Stability: BOX64_DYNAREC_STRONGMEM=1, BOX64_DYNAREC_SAFEFLAGS=2.',
      'Disable BOX64_DYNAREC_FASTNAN=0 and BOX64_DYNAREC_FASTROUND=0.',
      'Set BOX64_DYNAREC_BIGBLOCK=0 to isolate multi-block JIT miscompilations.'
    ]
  },
  {
    id: 'UNITY_MULTITHREAD_GFX',
    category: 'engine-unity',
    severity: 'high',
    pattern: /UnityPlayer|GfxDeviceWorker|WaitForSignal|d3d11: failed to lock/i,
    title: 'Unity GfxDeviceWorker Thread Stalling Under Wine/DXVK',
    rootCause: 'Unity multi-threaded renderer deadlocks on Wine/DXVK synchronization primitives.',
    fixes: [
      'Pass `-force-gfx-direct` in the executable launch arguments.',
      'Pair with WINEESYNC=1 and BOX64_DYNAREC_STRONGMEM=1.'
    ]
  },
  {
    id: 'SHADER_STUTTER_SPIKE',
    category: 'shader-compilation',
    severity: 'medium',
    pattern: /Compiling shader|pipeline cache|vkCreateGraphicsPipelines|stutter/i,
    title: 'Runtime Vulkan/DXVK Shader Compilation Stutter',
    rootCause: 'Driver is compiling shaders synchronously on render threads.',
    fixes: [
      'Add `dxvk.enableAsync = True` (requires DXVK async/gplasync fork) and `dxvk.numCompilerThreads = 1` in `dxvk.conf`.',
      'For native SDL2/XenonRecomp ports, pre-bake SPIR-V pipelines offline.'
    ]
  },
  {
    id: 'NDK_LINKER_MISSING_LIB',
    category: 'ndk-build',
    severity: 'high',
    pattern: /undefined (?:reference to|symbol:?)\s*.*(?:__android_log_print|AAudio|vkCreateInstance|ALooper)/i,
    title: 'Android NDK Linker Missing System Library',
    rootCause: 'CMake target does not link Android platform libraries (`log`, `aaudio`, `vulkan`, `android`).',
    fixes: [
      'Use `find_library(LOG_LIB log)` / `aaudio` / `vulkan` / `android` and link them in `target_link_libraries(...)`.',
      'Verify `minSdk >= 26` in `build.gradle.kts` when linking `aaudio`.'
    ]
  },
  {
    id: 'ANDROID_MPROTECT_OR_PAGE_ALIGN',
    category: 'android-sandbox',
    severity: 'high',
    pattern: /mprotect.*(?:EACCES|Permission denied)|16 KB|LOAD segment.*not aligned|W\^X/i,
    title: 'Android SELinux W^X / mprotect or 16KB Page Alignment Error',
    rootCause: 'JIT/recomp write-tracking or native `.so` layout violates Android SELinux W^X or 16KB ELF alignment on API 35+.',
    fixes: [
      'Avoid RWX mprotect transitions; use separate read-write and read-exec mappings or software dirty-bit tracking.',
      'Add `-Wl,-z,max-page-size=16384` to NDK linker flags for Android 15+ 16KB page compatibility.'
    ]
  },
  {
    id: 'SCOPED_STORAGE_DENIED',
    category: 'android-storage',
    severity: 'medium',
    pattern: /(?:\/sdcard\/|\/storage\/emulated|Android\/obb).*(?:EACCES|Permission denied|ENOENT)/i,
    title: 'Android Scoped Storage Path Access Failure',
    rootCause: 'Desktop/Wine path expects legacy global storage access blocked on Android 11+.',
    fixes: [
      'Store assets inside app-specific external storage (`Context.getExternalFilesDir`) or container-mapped drive `D:\\`.',
      'For ADB testing, verify directory permissions via `adb shell run-as` or SAF grants.'
    ]
  }
];

function diagnoseLogText(logText) {
  if (typeof logText !== 'string' || !logText.trim()) {
    throw new Error('logText must be a non-empty string');
  }
  const lines = logText.split(/\r?\n/);
  const findings = [];

  for (const rule of LOG_RULES) {
    const matchedLines = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (rule.pattern.test(lines[i])) {
        matchedLines.push({ line: i + 1, text: lines[i].slice(0, 220) });
        if (matchedLines.length >= 5) break;
      }
    }
    if (matchedLines.length > 0) {
      findings.push({
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        rootCause: rule.rootCause,
        fixes: rule.fixes,
        evidence: matchedLines
      });
    }
  }

  return {
    lineCount: lines.length,
    matchCount: findings.length,
    findings,
    summary: findings.length > 0
      ? `Detected ${findings.length} root-cause pattern(s): ${findings.map((f) => f.id).join(', ')}`
      : 'No known porting/runtime error signatures matched; inspect full stack trace or increase WINEDEBUG/BOX64_LOG verbosity.'
  };
}

function diagnoseLogFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Log file does not exist: ${abs}`);
  }
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Invalid log file target: ${abs}`);
  }
  const text = fs.readFileSync(abs, 'utf8');
  return {
    filePath: abs,
    ...diagnoseLogText(text)
  };
}

function runAdbCommand(args, adbBinary = process.env.ANDROID_ADB_PATH || 'adb') {
  return new Promise((resolve) => {
    execFile(adbBinary, args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.code === 'ENOENT' ? 'adb binary not found on PATH' : err.message, stdout: stdout || '', stderr: stderr || '' });
        return;
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function probeAdb({ adbBinary } = {}) {
  const devRes = await runAdbCommand(['devices', '-l'], adbBinary);
  if (!devRes.ok) {
    return {
      available: false,
      reason: devRes.error,
      devices: []
    };
  }
  const lines = devRes.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);

  const devices = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';
    const info = { serial, state, raw: line };
    if (state === 'device') {
      const abiRes = await runAdbCommand(['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi'], adbBinary);
      const socRes = await runAdbCommand(['-s', serial, 'shell', 'getprop', 'ro.soc.model'], adbBinary);
      const hwRes = await runAdbCommand(['-s', serial, 'shell', 'getprop', 'ro.hardware'], adbBinary);
      info.abi = abiRes.ok ? abiRes.stdout.trim() : null;
      info.socModel = socRes.ok ? socRes.stdout.trim() : null;
      info.hardware = hwRes.ok ? hwRes.stdout.trim() : null;
    }
    devices.push(info);
  }

  return {
    available: true,
    devices
  };
}

module.exports = {
  LOG_RULES,
  diagnoseLogText,
  diagnoseLogFile,
  probeAdb
};
