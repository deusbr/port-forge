'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BINARY_INSPECT_BYTES = 128 * 1024 * 1024; // 128 MiB cap for safe full-buffer PE/XEX reads
const MAX_SOURCE_FILES = 800;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  'Library',
  'Temp',
  'obj'
]);

const MACHINE_NAMES = {
  0x014c: 'x86 (32-bit)',
  0x8664: 'x86_64 (64-bit)',
  0xaa64: 'arm64 (AArch64)',
  0x01c4: 'arm (32-bit Thumb-2)',
  0x01f2: 'powerpc-be (Xbox 360)'
};

const SUBSYSTEM_NAMES = {
  1: 'Native',
  2: 'Windows GUI',
  3: 'Windows CUI (Console)',
  7: 'POSIX CUI',
  9: 'Windows CE',
  14: 'Xbox'
};

function readAsciiZ(buf, offset, maxLen = 256) {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  const limit = Math.min(buf.length, offset + maxLen);
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.slice(offset, end).toString('ascii');
}

function rvaToOffset(rva, sections) {
  if (!rva) return -1;
  for (const sec of sections) {
    const span = Math.max(sec.virtualSize, sec.sizeOfRawData);
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
      const delta = rva - sec.virtualAddress;
      if (delta < sec.sizeOfRawData) {
        return sec.pointerToRawData + delta;
      }
      return -1;
    }
  }
  return rva;
}

function classifyImportedDlls(dllNames) {
  const lower = dllNames.map((d) => d.toLowerCase());
  const has = (re) => lower.some((d) => re.test(d));

  const graphicsApis = [];
  if (has(/^d3d8\.dll$/)) graphicsApis.push('Direct3D 8');
  if (has(/^d3d9/)) graphicsApis.push('Direct3D 9');
  if (has(/^d3d10/)) graphicsApis.push('Direct3D 10');
  if (has(/^d3d11/)) graphicsApis.push('Direct3D 11');
  if (has(/^d3d12/)) graphicsApis.push('Direct3D 12');
  if (has(/^dxgi\.dll$/)) graphicsApis.push('DXGI');
  if (has(/^opengl32\.dll$/)) graphicsApis.push('OpenGL');
  if (has(/^vulkan-1\.dll$/)) graphicsApis.push('Vulkan');
  if (has(/^sdl2?\.dll$/)) graphicsApis.push('SDL');

  const audioApis = [];
  if (has(/xaudio2/)) audioApis.push('XAudio2');
  if (has(/^dsound\.dll$/)) audioApis.push('DirectSound');
  if (has(/^winmm\.dll$/)) audioApis.push('WinMM');
  if (has(/fmod/)) audioApis.push('FMOD');
  if (has(/openal/)) audioApis.push('OpenAL');

  const inputApis = [];
  if (has(/xinput/)) inputApis.push('XInput');
  if (has(/^dinput/)) inputApis.push('DirectInput');

  const engines = [];
  if (has(/unityplayer/)) engines.push('Unity');
  if (has(/^ue4|unreal|physx/)) engines.push('Unreal / PhysX');
  if (has(/^node\.dll$|libcef|chrome_elf/)) engines.push('Electron / CEF');
  if (has(/mscoree|coreclr|clr\.dll/)) engines.push('.NET / CLR');
  if (has(/python3?\d*\.dll/)) engines.push('Python Embedded');
  if (has(/^sdl2?\.dll$/)) engines.push('SDL2');

  const runtimes = [];
  if (has(/vcruntime140|msvcp140/)) runtimes.push('MSVC 2015-2022 Redist');
  if (has(/vcruntime120|msvcr120|msvcr110|msvcr100/)) runtimes.push('Legacy MSVC Redist (2010-2013)');
  if (has(/steam_api/)) runtimes.push('Steamworks SDK');

  const blockers = [];
  if (has(/easyanticheat|battleye|vanguard|vgk|nprotect|gameguard/)) {
    blockers.push({
      severity: 'critical',
      code: 'KERNEL_ANTICHEAT',
      message: 'Kernel-level anti-cheat DLL reference detected; Wine/Winlator and mobile translation layers cannot run kernel anti-cheat drivers.'
    });
  }
  if (has(/d3d12/)) {
    blockers.push({
      severity: 'high',
      code: 'D3D12_VKD3D',
      message: 'Direct3D 12 requires vkd3d-proton translation on Android Vulkan drivers and has strict Timeline Semaphore / descriptor requirements.'
    });
  }

  return {
    graphicsApis: [...new Set(graphicsApis)],
    audioApis: [...new Set(audioApis)],
    inputApis: [...new Set(inputApis)],
    engines: [...new Set(engines)],
    runtimes: [...new Set(runtimes)],
    blockers
  };
}

function inspectPeBuffer(buf, filePath) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`Not a valid PE binary (missing MZ header): ${filePath}`);
  }
  const eLfanew = buf.readUInt32LE(0x3c);
  if (eLfanew + 24 > buf.length || buf.readUInt32LE(eLfanew) !== 0x00004550) {
    throw new Error(`Not a valid PE binary (missing PE signature): ${filePath}`);
  }

  const coffOffset = eLfanew + 4;
  const machine = buf.readUInt16LE(coffOffset);
  const numberOfSections = buf.readUInt16LE(coffOffset + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coffOffset + 16);
  const characteristics = buf.readUInt16LE(coffOffset + 18);

  const optOffset = coffOffset + 20;
  if (optOffset + sizeOfOptionalHeader > buf.length || sizeOfOptionalHeader < 2) {
    throw new Error(`Truncated PE optional header: ${filePath}`);
  }

  const optMagic = buf.readUInt16LE(optOffset);
  const isPe32Plus = optMagic === 0x20b;
  const isPe32 = optMagic === 0x10b;
  if (!isPe32 && !isPe32Plus) {
    throw new Error(`Unsupported PE OptionalHeader magic: 0x${optMagic.toString(16)}`);
  }

  const subsystem = sizeOfOptionalHeader >= 70 ? buf.readUInt16LE(optOffset + 68) : 0;
  const dataDirStart = optOffset + (isPe32Plus ? 112 : 96);
  const numRvas = sizeOfOptionalHeader >= (isPe32Plus ? 112 : 96)
    ? buf.readUInt32LE(optOffset + (isPe32Plus ? 108 : 92))
    : 0;

  const secOffset = optOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < Math.min(numberOfSections, 96); i += 1) {
    const off = secOffset + i * 40;
    if (off + 40 > buf.length) break;
    const rawName = buf.slice(off, off + 8).toString('ascii').replace(/\0+$/, '');
    sections.push({
      name: rawName,
      virtualSize: buf.readUInt32LE(off + 8),
      virtualAddress: buf.readUInt32LE(off + 12),
      sizeOfRawData: buf.readUInt32LE(off + 16),
      pointerToRawData: buf.readUInt32LE(off + 20)
    });
  }

  const importedDlls = [];
  if (numRvas >= 2 && dataDirStart + 16 <= optOffset + sizeOfOptionalHeader) {
    const importRva = buf.readUInt32LE(dataDirStart + 8);
    const importOff = rvaToOffset(importRva, sections);
    if (importOff >= 0) {
      for (let i = 0; i < 256; i += 1) {
        const descOff = importOff + i * 20;
        if (descOff + 20 > buf.length) break;
        const origFirstThunk = buf.readUInt32LE(descOff);
        const nameRva = buf.readUInt32LE(descOff + 12);
        const firstThunk = buf.readUInt32LE(descOff + 16);
        if (origFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
        const nameOff = rvaToOffset(nameRva, sections);
        if (nameOff >= 0) {
          const dllName = readAsciiZ(buf, nameOff, 128);
          if (dllName) importedDlls.push(dllName);
        }
      }
    }
  }

  const classified = classifyImportedDlls(importedDlls);
  const arch = MACHINE_NAMES[machine] || `0x${machine.toString(16)}`;
  const isDll = Boolean(characteristics & 0x2000);
  const blockers = [...classified.blockers];
  if (machine === 0x014c) {
    blockers.push({
      severity: 'medium',
      code: 'WOW64_32BIT',
      message: '32-bit x86 binary requires Box86/WoW64 mode under Winlator ARM64 containers (prefer Bionic/CMOD WoW64 builds).'
    });
  }

  const readinessScore = Math.max(
    15,
    Math.min(
      95,
      82 -
        blockers.reduce((acc, b) => acc + (b.severity === 'critical' ? 45 : b.severity === 'high' ? 18 : 8), 0)
    )
  );

  return {
    kind: 'binary-pe',
    targetPath: path.resolve(filePath),
    format: isPe32Plus ? 'PE32+ (64-bit Windows)' : 'PE32 (32-bit Windows)',
    isDll,
    arch,
    machineHex: `0x${machine.toString(16)}`,
    subsystem: SUBSYSTEM_NAMES[subsystem] || `Subsystem(${subsystem})`,
    sections: sections.map((s) => s.name),
    importedDlls,
    ...classified,
    blockers,
    recommendedStrategy: blockers.some((b) => b.code === 'KERNEL_ANTICHEAT')
      ? 'blocked-kernel-anticheat'
      : 'winlator-translation',
    readinessScore,
    legalNotice: 'Analysis operates strictly on user-supplied local binaries. Do not bundle proprietary game assets or redistributables.'
  };
}

function inspectXexBuffer(buf, filePath) {
  if (buf.length < 24 || buf.toString('ascii', 0, 4) !== 'XEX2') {
    throw new Error(`Not a valid XEX2 binary: ${filePath}`);
  }
  const moduleFlags = buf.readUInt32BE(4);
  const peDataOffset = buf.readUInt32BE(8);
  const securityInfoOffset = buf.readUInt32BE(16);
  const headerCount = buf.readUInt32BE(20);

  const optionalHeaders = [];
  let executionInfo = null;
  let entryPoint = null;
  let baseAddress = null;

  for (let i = 0; i < Math.min(headerCount, 64); i += 1) {
    const off = 24 + i * 8;
    if (off + 8 > buf.length) break;
    const key = buf.readUInt32BE(off);
    const val = buf.readUInt32BE(off + 4);
    optionalHeaders.push(`0x${key.toString(16).padStart(8, '0')}`);

    if (key === 0x00010100) entryPoint = `0x${val.toString(16).padStart(8, '0')}`;
    if (key === 0x00010201) baseAddress = `0x${val.toString(16).padStart(8, '0')}`;
    if (key === 0x00040006 && val + 24 <= buf.length) {
      executionInfo = {
        mediaId: `0x${buf.readUInt32BE(val).toString(16).padStart(8, '0')}`,
        titleId: `0x${buf.readUInt32BE(val + 12).toString(16).padStart(8, '0')}`
      };
    }
  }

  const blockers = [
    {
      severity: 'high',
      code: 'BIG_ENDIAN_PPC',
      message: 'PowerPC Big-Endian memory model requires volatile byte-swap helpers on ARM64 Little-Endian.'
    },
    {
      severity: 'high',
      code: 'VMX_TO_NEON',
      message: 'Xbox 360 VMX128 vector instructions require SIMD mapping to ARM64 NEON intrinsics.'
    },
    {
      severity: 'high',
      code: 'XENOS_PM4_VULKAN',
      message: 'Xenos GPU PM4 command buffers and shaders require DXC/SPIR-V translation and Android-safe pipeline caching.'
    },
    {
      severity: 'medium',
      code: 'ANDROID_MPROTECT',
      message: 'Self-modifying or write-tracked memory pages must respect Android SELinux/mprotect restrictions.'
    }
  ];

  return {
    kind: 'binary-xex2',
    targetPath: path.resolve(filePath),
    format: 'XEX2 (Xbox 360 Executable)',
    arch: 'PowerPC 64/32 Big-Endian (Xenon)',
    moduleFlags: `0x${moduleFlags.toString(16).padStart(8, '0')}`,
    peDataOffset,
    securityInfoOffset,
    optionalHeaderCount: headerCount,
    optionalHeaders,
    entryPoint,
    baseAddress,
    executionInfo,
    graphicsApis: ['Xenos / Direct3D 9 Xbox'],
    audioApis: ['XMA2 / XAudio'],
    inputApis: ['XInput (Xbox 360)'],
    engines: ['XenonRecomp Static Recompilation Candidate'],
    runtimes: ['XAM / XboxKrnl HLE Shims'],
    blockers,
    recommendedStrategy: 'xenon-recomp-arm64',
    readinessScore: 54,
    legalNotice: 'Only inspect legally dumped, user-owned binaries. Port-Forge never provides keys, ROMs, or decryption tools.'
  };
}

function collectSourceFiles(rootDir) {
  const files = [];
  function walk(dir) {
    if (files.length >= MAX_SOURCE_FILES) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  walk(rootDir);
  return files;
}

function inspectSourceDirectory(dirPath) {
  const absDir = path.resolve(dirPath);
  const files = collectSourceFiles(absDir);
  const relFiles = files.map((f) => path.relative(absDir, f).replace(/\\/g, '/'));
  const hasFile = (name) => relFiles.some((f) => f === name || f.endsWith(`/${name}`));

  const textHits = {
    win32: false,
    dx9: false,
    dx11: false,
    dx12: false,
    opengl: false,
    vulkan: false,
    sdl2: false,
    xaudio: false,
    xinput: false,
    electron: false,
    nodeFsOrChild: false,
    pygame: false,
    kivy: false,
    tkinter: false,
    ppcRecomp: false
  };

  let packageJson = null;
  if (hasFile('package.json')) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
    } catch {
      packageJson = null;
    }
  }

  let godotVersion = null;
  if (hasFile('project.godot')) {
    const raw = fs.readFileSync(path.join(absDir, 'project.godot'), 'utf8');
    const m = raw.match(/config\/features=PackedStringArray\(([^)]+)\)/);
    godotVersion = m ? m[1] : 'Godot project';
  }

  let unityVersion = null;
  const unityVerFile = relFiles.find((f) => f.endsWith('ProjectSettings/ProjectVersion.txt'));
  if (unityVerFile) {
    const raw = fs.readFileSync(path.join(absDir, unityVerFile), 'utf8');
    const m = raw.match(/m_EditorVersion:\s*([^\r\n]+)/);
    unityVersion = m ? m[1].trim() : 'Unity project';
  }

  const scanExtensions = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.js', '.ts', '.py', '.txt', '.cmake', '.toml', '.vcxproj']);
  for (const absFile of files) {
    const ext = path.extname(absFile).toLowerCase();
    const base = path.basename(absFile);
    if (!scanExtensions.has(ext) && base !== 'CMakeLists.txt') continue;
    let st;
    try {
      st = fs.statSync(absFile);
    } catch {
      continue;
    }
    if (st.size > 512 * 1024) continue;
    const text = fs.readFileSync(absFile, 'utf8');
    if (/#include\s*<windows\.h>|CreateWindowEx|WndProc|\bHWND\b/i.test(text)) textHits.win32 = true;
    if (/d3d9\.h|IDirect3D9/i.test(text)) textHits.dx9 = true;
    if (/d3d11\.h|ID3D11Device/i.test(text)) textHits.dx11 = true;
    if (/d3d12\.h|ID3D12Device/i.test(text)) textHits.dx12 = true;
    if (/gl\/gl\.h|GLAD|GLFW|OpenGL/i.test(text)) textHits.opengl = true;
    if (/vulkan\/vulkan\.h|VkInstance|VK_KHR/i.test(text)) textHits.vulkan = true;
    if (/SDL2?\.h|SDL_Init|SDL_CreateWindow/i.test(text)) textHits.sdl2 = true;
    if (/xaudio2\.h|IXAudio2/i.test(text)) textHits.xaudio = true;
    if (/xinput\.h|XInputGetState/i.test(text)) textHits.xinput = true;
    if (/BrowserWindow|ipcMain|require\(['"]electron['"]\)/i.test(text)) textHits.electron = true;
    if (/node:fs|node:child_process|require\(['"](?:fs|child_process)['"]\)/i.test(text)) textHits.nodeFsOrChild = true;
    if (/\bimport pygame\b|from pygame\b/i.test(text)) textHits.pygame = true;
    if (/\bimport kivy\b|from kivy\b/i.test(text)) textHits.kivy = true;
    if (/\bimport tkinter\b|from tkinter\b/i.test(text)) textHits.tkinter = true;
    if (/PPCContext|XenonRecomp|XenosRecomp|__builtin_bswap|XamInput/i.test(text)) textHits.ppcRecomp = true;
  }

  let stack = 'unknown';
  let recommendedStrategy = 'manual-audit';
  if (textHits.ppcRecomp) {
    stack = 'xenon-recomp';
    recommendedStrategy = 'xenon-recomp-arm64';
  } else if (godotVersion) {
    stack = 'godot';
    recommendedStrategy = 'godot-android-export';
  } else if (unityVersion) {
    stack = 'unity';
    recommendedStrategy = 'unity-android-export';
  } else if (
    textHits.electron ||
    (packageJson && (packageJson.dependencies?.electron || packageJson.devDependencies?.electron))
  ) {
    stack = 'electron';
    recommendedStrategy = 'capacitor-android';
  } else if (hasFile('CMakeLists.txt') || relFiles.some((f) => /\.(cpp|cc|c|vcxproj)$/.test(f))) {
    stack = 'cpp-win32-dx';
    recommendedStrategy = 'android-ndk-sdl2';
  } else if (hasFile('pyproject.toml') || hasFile('requirements.txt') || relFiles.some((f) => f.endsWith('.py'))) {
    stack = 'python';
    recommendedStrategy = 'buildozer-kivy';
  }

  const graphicsApis = [];
  if (textHits.dx9) graphicsApis.push('Direct3D 9');
  if (textHits.dx11) graphicsApis.push('Direct3D 11');
  if (textHits.dx12) graphicsApis.push('Direct3D 12');
  if (textHits.opengl) graphicsApis.push('OpenGL');
  if (textHits.vulkan) graphicsApis.push('Vulkan');
  if (textHits.sdl2) graphicsApis.push('SDL2');

  const blockers = [];
  if (textHits.win32 && !textHits.sdl2) {
    blockers.push({
      severity: 'high',
      code: 'WIN32_WINDOWING',
      message: 'Direct Win32 HWND/WndProc calls detected; migrate windowing and event loop to SDL2 or Android NativeActivity.'
    });
  }
  if (textHits.dx11 || textHits.dx12 || textHits.dx9) {
    blockers.push({
      severity: 'high',
      code: 'DIRECTX_TRANSLATION',
      message: 'DirectX API calls require SPIRV-Cross / DXC shader translation and a Vulkan or GLES3 renderer backend.'
    });
  }
  if (stack === 'electron' && textHits.nodeFsOrChild) {
    blockers.push({
      severity: 'medium',
      code: 'NODE_DESKTOP_APIS',
      message: 'Node.js fs/child_process calls cannot run in Android WebView; replace with Capacitor plugins or IPC abstraction.'
    });
  }
  if (stack === 'python' && textHits.tkinter) {
    blockers.push({
      severity: 'high',
      code: 'TKINTER_DESKTOP_ONLY',
      message: 'Tkinter is not supported on Android APKs; migrate UI layer to Kivy, BeeWare Toga, or SDL2.'
    });
  }

  const readinessScore = Math.max(
    25,
    Math.min(
      95,
      88 - blockers.reduce((acc, b) => acc + (b.severity === 'high' ? 16 : 8), 0)
    )
  );

  return {
    kind: 'source-project',
    targetPath: absDir,
    stack,
    recommendedStrategy,
    fileCountScanned: files.length,
    buildFiles: relFiles.filter((f) =>
      /(CMakeLists\.txt|package\.json|pyproject\.toml|requirements\.txt|project\.godot|ProjectVersion\.txt|\.sln|\.vcxproj)$/i.test(f)
    ),
    graphicsApis,
    audioApis: textHits.xaudio ? ['XAudio2'] : [],
    inputApis: textHits.xinput ? ['XInput'] : [],
    engines: [
      godotVersion ? `Godot (${godotVersion})` : null,
      unityVersion ? `Unity (${unityVersion})` : null,
      textHits.sdl2 ? 'SDL2' : null
    ].filter(Boolean),
    signals: textHits,
    blockers,
    readinessScore
  };
}

function inspectTarget(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('targetPath is required');
  }
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Target does not exist: ${abs}`);
  }
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing symlink target: ${abs}`);
  }
  if (st.isDirectory()) {
    return inspectSourceDirectory(abs);
  }
  if (!st.isFile()) {
    throw new Error(`Unsupported target type: ${abs}`);
  }
  if (st.size > MAX_BINARY_INSPECT_BYTES) {
    throw new Error(`Binary exceeds ${MAX_BINARY_INSPECT_BYTES} bytes inspection cap: ${abs}`);
  }
  const buf = fs.readFileSync(abs);
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'XEX2') {
    return inspectXexBuffer(buf, abs);
  }
  if (buf.length >= 2 && buf.readUInt16LE(0) === 0x5a4d) {
    return inspectPeBuffer(buf, abs);
  }
  throw new Error(`Unsupported binary format (expected PE .exe/.dll or Xbox .xex): ${abs}`);
}

module.exports = {
  inspectTarget,
  inspectPeBuffer,
  inspectXexBuffer,
  inspectSourceDirectory,
  rvaToOffset,
  classifyImportedDlls
};
