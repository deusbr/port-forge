'use strict';

const SOC_PROFILES = {
  'adreno-7xx': {
    id: 'adreno-7xx',
    name: 'Qualcomm Snapdragon 8 Gen 2 / Gen 3 / Elite (Adreno 740/750/830)',
    gpuVendor: 'qualcomm-adreno',
    supportsTurnip: true,
    preferredDriver: 'Turnip (Mesa Freedreno Vulkan)',
    timelineSemaphoresReliable: true,
    recommendedDxvk: '2.4.1-gplasync (or 2.5.x on Turnip >= 25.0)',
    supportsVkd3d: true
  },
  'adreno-6xx': {
    id: 'adreno-6xx',
    name: 'Qualcomm Snapdragon 855 / 865 / 870 (Adreno 640/650)',
    gpuVendor: 'qualcomm-adreno',
    supportsTurnip: true,
    preferredDriver: 'Turnip Legacy / 24.1.x',
    timelineSemaphoresReliable: false,
    recommendedDxvk: '2.4.1 (pin <= 2.4.1 to avoid Timeline Semaphore hangs)',
    supportsVkd3d: false
  },
  'mali-immortalis': {
    id: 'mali-immortalis',
    name: 'MediaTek Dimensity / Google Tensor (ARM Mali / Immortalis)',
    gpuVendor: 'arm-mali',
    supportsTurnip: false,
    preferredDriver: 'Vortek / System Vulkan Wrapper (fallback VirGL for D3D9)',
    timelineSemaphoresReliable: false,
    recommendedDxvk: '1.10.3 (D3D9/D3D11 light) or 2.3.1',
    supportsVkd3d: false
  },
  'xclipse-rdna': {
    id: 'xclipse-rdna',
    name: 'Samsung Exynos Xclipse (AMD RDNA Mobile)',
    gpuVendor: 'samsung-amd',
    supportsTurnip: false,
    preferredDriver: 'System Vulkan Wrapper / Vortek',
    timelineSemaphoresReliable: true,
    recommendedDxvk: '2.4.1',
    supportsVkd3d: true
  },
  'generic-arm64': {
    id: 'generic-arm64',
    name: 'Generic ARM64 Android Device',
    gpuVendor: 'unknown',
    supportsTurnip: false,
    preferredDriver: 'VirGL / System Wrapper',
    timelineSemaphoresReliable: false,
    recommendedDxvk: '1.10.3',
    supportsVkd3d: false
  }
};

const RUNTIME_FORKS = {
  'winlator-cmod': {
    id: 'winlator-cmod',
    name: 'Winlator CMOD',
    supportsFex: true,
    supportsWcp: true,
    notes: 'Strong ARM64EC/FEX + custom .wcp Turnip/DXVK switching and controller profiles.'
  },
  'winlator-bionic': {
    id: 'winlator-bionic',
    name: 'Winlator Bionic',
    supportsFex: true,
    supportsWcp: true,
    notes: 'Native Android Bionic libc container builds reduce syscall overhead on Snapdragon.'
  },
  'winlator-ludashi': {
    id: 'winlator-ludashi',
    name: 'Winlator Ludashi / Benchmark Fork',
    supportsFex: true,
    supportsWcp: true,
    notes: 'Tuned performance defaults; verify Box64 stability flags on Unity/UE titles.'
  },
  'winlator-frost': {
    id: 'winlator-frost',
    name: 'Winlator Frost',
    supportsFex: false,
    supportsWcp: true,
    notes: 'Popular Box64/WoW64 fork with curated component packs and registry presets.'
  },
  'winlator-upstream': {
    id: 'winlator-upstream',
    name: 'Winlator Upstream (brunodev85)',
    supportsFex: false,
    supportsWcp: false,
    notes: 'Baseline release; prefer Box64 Stability/Compatibility presets for complex engines.'
  }
};

function recommendRuntime({
  inspection = null,
  soc = 'adreno-7xx',
  runtime = 'winlator-cmod',
  goal = 'balanced'
} = {}) {
  const socProfile = SOC_PROFILES[soc] || SOC_PROFILES['adreno-7xx'];
  const fork = RUNTIME_FORKS[runtime] || RUNTIME_FORKS['winlator-cmod'];
  const normalizedGoal = ['fps', 'stability', 'battery', 'balanced'].includes(goal) ? goal : 'balanced';

  const apis = new Set([
    ...(inspection?.graphicsApis || []),
    ...(inspection?.engines || []),
    ...(inspection?.runtimes || [])
  ]);

  const isUnity = [...apis].some((x) => /unity/i.test(x));
  const isUnreal = [...apis].some((x) => /unreal/i.test(x));
  const isDx12 = [...apis].some((x) => /Direct3D 12/i.test(x));
  const isDx11 = [...apis].some((x) => /Direct3D 11|DXGI/i.test(x));
  const isDx9 = [...apis].some((x) => /Direct3D 9|Direct3D 8/i.test(x));
  const isOpenGl = [...apis].some((x) => /OpenGL/i.test(x));
  const is32Bit = inspection?.arch?.includes('32-bit') || inspection?.machineHex === '0x14c';

  const useFex = Boolean(fork.supportsFex && !is32Bit && socProfile.supportsTurnip && normalizedGoal !== 'stability');
  const translator = useFex ? 'FEX-Emu (ARM64EC / x86_64)' : is32Bit ? 'Box64 (WoW64) / Box86' : 'Box64 Dynarec';

  let box64Preset = 'Intermediate / Balanced';
  const env = {
    WINEESYNC: '1',
    WINEDEBUG: '-all'
  };

  if (normalizedGoal === 'stability' || isUnity || isUnreal) {
    box64Preset = 'Stability (STRONGMEM=1, SAFEFLAGS=2)';
    env.BOX64_DYNAREC_SAFEFLAGS = '2';
    env.BOX64_DYNAREC_STRONGMEM = '1';
    env.BOX64_DYNAREC_BIGBLOCK = '0';
    env.BOX64_DYNAREC_FASTNAN = '0';
    env.BOX64_DYNAREC_FASTROUND = '0';
  } else if (normalizedGoal === 'fps') {
    box64Preset = 'Performance (BIGBLOCK=3, FASTNAN=1, STRONGMEM=0)';
    env.BOX64_DYNAREC_SAFEFLAGS = '1';
    env.BOX64_DYNAREC_STRONGMEM = '0';
    env.BOX64_DYNAREC_BIGBLOCK = '3';
    env.BOX64_DYNAREC_FASTNAN = '1';
    env.BOX64_DYNAREC_FASTROUND = '1';
  } else {
    env.BOX64_DYNAREC_SAFEFLAGS = '1';
    env.BOX64_DYNAREC_STRONGMEM = '1';
    env.BOX64_DYNAREC_BIGBLOCK = '1';
    env.BOX64_DYNAREC_FASTNAN = '1';
    env.BOX64_DYNAREC_FASTROUND = '0';
  }

  let graphicsWrapper = socProfile.recommendedDxvk;
  if (isDx12) {
    graphicsWrapper = socProfile.supportsVkd3d ? 'vkd3d-proton (2.12+)' : 'Blocked / Low FPS (No reliable vkd3d on this GPU)';
  } else if (isOpenGl && !isDx11 && !isDx9) {
    graphicsWrapper = socProfile.supportsTurnip ? 'Zink (Mesa OpenGL-over-Vulkan)' : 'VirGL';
  } else if (isDx9 && !isDx11) {
    graphicsWrapper = socProfile.supportsTurnip ? 'DXVK 1.10.3 (D3D9)' : 'WineD3D / VirGL';
  }

  if (socProfile.supportsTurnip) {
    env.MESA_EXTENSION_MAX_YEAR = '2024';
    env.TU_DEBUG = 'noconform';
  }

  const dxvkConfLines = [
    '# Generated by port-forge Winlator/DXVK Oracle',
    `dxvk.numCompilerThreads = ${normalizedGoal === 'battery' ? 1 : 2}`,
    `dxvk.enableAsync = ${normalizedGoal === 'stability' ? 'False' : 'True'}`,
    'dxvk.tearFree = False'
  ];
  if (isDx9) {
    dxvkConfLines.push('d3d9.maxFrameLatency = 1');
  }
  if (!socProfile.timelineSemaphoresReliable && isDx11) {
    dxvkConfLines.push('# Keep DXVK <= 2.4.1 on Adreno 6xx / Mali to avoid timeline semaphore freezes');
  }

  const launchArgs = [];
  if (isUnity) {
    launchArgs.push('-force-gfx-direct');
  }

  const warnings = [];
  if (!socProfile.timelineSemaphoresReliable && isDx11) {
    warnings.push('Do NOT upgrade DXVK past 2.4.1 on this SoC unless custom Turnip exposes stable VK_KHR_timeline_semaphore.');
  }
  if (isUnity) {
    warnings.push('Unity engine detected: pass `-force-gfx-direct` to prevent multi-threaded renderer freezes in Wine/DXVK.');
  }
  if (isDx12 && !socProfile.supportsVkd3d) {
    warnings.push('Direct3D 12 on Mali/Adreno 6xx frequently hits VK_ERROR_DEVICE_LOST; force `-dx11` if supported by the binary.');
  }
  if (inspection?.blockers?.some((b) => b.code === 'KERNEL_ANTICHEAT')) {
    warnings.push('CRITICAL: Kernel anti-cheat detected. Container execution will fail offline/online checks.');
  }

  const wcpManifest = {
    fork: fork.id,
    translator,
    graphicsDriver: socProfile.preferredDriver,
    dxWrapper: graphicsWrapper,
    audioDriver: 'PulseAudio / AAudio bridge',
    winComponents: ['vcrun2022', ...(isDx9 ? ['d3dx9'] : [])]
  };

  const containerPreset = {
    schema: 'port-forge.winlator-container/v1',
    name: inspection?.targetPath ? `${require('node:path').basename(inspection.targetPath)} (${socProfile.id})` : `Container (${socProfile.id})`,
    screenSize: normalizedGoal === 'fps' ? '1280x720' : '1600x900',
    graphicsDriver: socProfile.supportsTurnip ? 'Turnip' : 'Vortek',
    dxWrapper: graphicsWrapper,
    translator,
    box64Preset,
    execArgs: launchArgs.join(' '),
    env,
    dxvkConf: dxvkConfLines.join('\n')
  };

  return {
    socProfile,
    runtimeFork: fork,
    goal: normalizedGoal,
    translator,
    box64Preset,
    graphicsDriver: socProfile.preferredDriver,
    graphicsWrapper,
    launchArgs,
    env,
    dxvkConf: dxvkConfLines.join('\n'),
    wcpManifest,
    containerPreset,
    warnings
  };
}

module.exports = {
  SOC_PROFILES,
  RUNTIME_FORKS,
  recommendRuntime
};
