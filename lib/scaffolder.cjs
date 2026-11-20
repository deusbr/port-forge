'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { recommendRuntime } = require('./winlator-oracle.cjs');

const STRATEGIES = [
  'android-ndk-sdl2',
  'xenon-recomp-arm64',
  'capacitor-android',
  'buildozer-kivy',
  'godot-android-export',
  'unity-android-export',
  'winlator-container'
];

function sanitizeAppId(name) {
  const clean = String(name || 'portedapp')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[0-9]+/, '');
  return `dev.portforge.${clean || 'portedapp'}`;
}

function safeJoin(rootDir, relPath) {
  const absRoot = path.resolve(rootDir);
  const resolved = path.resolve(absRoot, relPath);
  const rel = path.relative(absRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing unsafe relative output path: ${relPath}`);
  }
  return resolved;
}

function buildFilesForStrategy({ strategy, appName, inspection, oracle }) {
  const safeName = String(appName || 'PortedApp').replace(/[^A-Za-z0-9_-]/g, '_');
  const appId = sanitizeAppId(safeName);

  if (strategy === 'android-ndk-sdl2') {
    return [
      {
        relPath: 'CMakeLists.txt',
        content: `cmake_minimum_required(VERSION 3.22.1)
project(${safeName} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Point SDL2_DIR or add SDL2 as a git submodule under third_party/SDL
find_package(SDL2 REQUIRED CONFIG)

add_library(main SHARED
  src/main_android.cpp
)

find_library(ANDROID_LIB android)
find_library(LOG_LIB log)
find_library(AAUDIO_LIB aaudio)
find_library(VULKAN_LIB vulkan)

target_include_directories(main PRIVATE
  \${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(main
  SDL2::SDL2
  \${ANDROID_LIB}
  \${LOG_LIB}
  \${AAUDIO_LIB}
  \${VULKAN_LIB}
)
`
      },
      {
        relPath: 'app/build.gradle.kts',
        content: `plugins {
    id("com.android.application")
}

android {
    namespace = "${appId}"
    compileSdk = 34

    defaultConfig {
        applicationId = "${appId}"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("../CMakeLists.txt")
            version = "3.22.1"
        }
    }
}
`
      },
      {
        relPath: 'app/src/main/AndroidManifest.xml',
        content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-feature android:name="android.hardware.vulkan.level" android:required="true" />
    <uses-feature android:name="android.hardware.gamepad" android:required="false" />

    <application
        android:label="${safeName}"
        android:hasCode="true">
        <activity
            android:name="org.libsdl.app.SDLActivity"
            android:configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|smallestScreenSize"
            android:screenOrientation="landscape"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`
      },
      {
        relPath: 'src/platform_bridge.hpp',
        content: `#pragma once
#include <SDL.h>
#ifdef __ANDROID__
#include <android/log.h>
#include <aaudio/AAudio.h>
#endif

namespace portforge {

struct WindowHandle {
    SDL_Window* window = nullptr;
    bool running = true;
};

inline WindowHandle create_surface(const char* title, int w, int h) {
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMECONTROLLER);
    SDL_Window* win = SDL_CreateWindow(
        title,
        SDL_WINDOWPOS_CENTERED,
        SDL_WINDOWPOS_CENTERED,
        w,
        h,
        SDL_WINDOW_VULKAN | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI
    );
    return WindowHandle{ win, win != nullptr };
}

} // namespace portforge
`
      },
      {
        relPath: 'src/main_android.cpp',
        content: `#include "platform_bridge.hpp"

int main(int argc, char* argv[]) {
    (void)argc;
    (void)argv;
    auto surface = portforge::create_surface("${safeName}", 1280, 720);
    SDL_Event ev;
    while (surface.running) {
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) {
                surface.running = false;
            }
        }
    }
    if (surface.window) {
        SDL_DestroyWindow(surface.window);
    }
    SDL_Quit();
    return 0;
}
`
      },
      {
        relPath: 'PORTING_BLUEPRINT.md',
        content: `# ${safeName} — Android NDK + SDL2 + Vulkan Blueprint

- **Detected Stack:** ${inspection?.stack || 'cpp-win32-dx'}
- **Graphics APIs:** ${(inspection?.graphicsApis || []).join(', ') || 'None specified'}
- **Target ABI:** \`arm64-v8a\` (minSdk 26 for AAudio + Vulkan 1.1)

## Migration Checklist
1. Replace \`CreateWindowEx\` / \`WndProc\` / \`PeekMessage\` with \`portforge::create_surface\` + \`SDL_PollEvent\`.
2. Translate HLSL / Direct3D shaders to Vulkan SPIR-V offline using \`dxc\` + \`SPIRV-Cross\`.
3. Map \`XInputGetState\` to \`SDL_GameControllerGetAxis\` / \`SDL_GameControllerGetButton\`.
4. Replace \`XAudio2\` voices with \`SDL_OpenAudioDevice\` or \`AAudio\` stream callbacks.
5. Link \`${appId}\` via Android Studio or \`./gradlew assembleDebug\` and inspect runtime with \`port-forge diagnose\`.
`
      }
    ];
  }

  if (strategy === 'xenon-recomp-arm64') {
    return [
      {
        relPath: 'CMakeLists.txt',
        content: `cmake_minimum_required(VERSION 3.22.1)
project(${safeName}_XboxRecomp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(${safeName}_runtime SHARED
  include/xenon_android_shim.hpp
)

if(ANDROID)
  find_library(LOG_LIB log)
  find_library(VULKAN_LIB vulkan)
  find_library(AAUDIO_LIB aaudio)
  target_link_libraries(${safeName}_runtime \${LOG_LIB} \${VULKAN_LIB} \${AAUDIO_LIB})
endif()
`
      },
      {
        relPath: 'include/xenon_android_shim.hpp',
        content: `#pragma once
#include <cstdint>
#if defined(__aarch64__)
#include <arm_neon.h>
#endif

namespace portforge::xenon {

// PowerPC Big-Endian -> ARM64 Little-Endian deterministic swaps
inline uint16_t bswap16(uint16_t v) { return __builtin_bswap16(v); }
inline uint32_t bswap32(uint32_t v) { return __builtin_bswap32(v); }
inline uint64_t bswap64(uint64_t v) { return __builtin_bswap64(v); }

template <typename T>
inline T load_be(const volatile void* addr) {
    T raw = *reinterpret_cast<const volatile T*>(addr);
    if constexpr (sizeof(T) == 2) return static_cast<T>(bswap16(static_cast<uint16_t>(raw)));
    if constexpr (sizeof(T) == 4) return static_cast<T>(bswap32(static_cast<uint32_t>(raw)));
    if constexpr (sizeof(T) == 8) return static_cast<T>(bswap64(static_cast<uint64_t>(raw)));
    return raw;
}

#if defined(__aarch64__)
inline float32x4_t vmx_add_f32(float32x4_t a, float32x4_t b) {
    return vaddq_f32(a, b);
}
#endif

} // namespace portforge::xenon
`
      },
      {
        relPath: 'PORTING_BLUEPRINT.md',
        content: `# ${safeName} — Xbox 360 Static Recompilation (XenonRecomp -> Android ARM64) Blueprint

> **Legal Notice:** Process only legally dumped, user-owned binaries. Never bundle keys or proprietary assets.

- **Target:** PowerPC Big-Endian (\`.xex\`) -> C++20 -> Clang ARM64 (\`aarch64-linux-android28\`)
- **Title ID:** ${inspection?.executionInfo?.titleId || 'N/A'}

## Engineering Checklist
1. **Endianness:** Route every guest memory load/store through \`portforge::xenon::load_be<T>\` with \`volatile\` where hardware registers/spinlocks occur.
2. **SIMD (VMX128 -> ARM NEON):** Map \`__vector\` 128-bit lanes cleanly to \`float32x4_t\` / \`uint32x4_t\` preserving NaN/saturation semantics.
3. **Graphics (XenosRecomp -> Vulkan SPIR-V):** Pre-compile Xbox microcode shaders offline to SPIR-V to avoid runtime Adreno stall; guard \`VK_KHR_timeline_semaphore\` usage by SoC.
4. **Memory & Android Sandbox:** Avoid dynamic RWX JIT pages; pre-allocate guest address window safely respecting Android 16KB page alignment on API 35+.
5. **HLE Shims:** Implement minimal \`XAM\`, \`Ke*\` threads/TLS, and route \`XAudio\` / \`XMA2\` to \`AAudio\`.
`
      }
    ];
  }

  if (strategy === 'capacitor-android') {
    return [
      {
        relPath: 'capacitor.config.json',
        content: JSON.stringify(
          {
            appId,
            appName: safeName,
            webDir: 'dist',
            android: {
              allowMixedContent: false
            }
          },
          null,
          2
        )
      },
      {
        relPath: 'android-shims/native-bridge.ts',
        content: `// Replace Electron ipcRenderer / node:fs calls with Capacitor plugins on Android
export async function readPortableText(key: string): Promise<string | null> {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    return (window as any).electronAPI.readText(key);
  }
  return localStorage.getItem(key);
}

export async function writePortableText(key: string, value: string): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    return (window as any).electronAPI.writeText(key, value);
  }
  localStorage.setItem(key, value);
}
`
      },
      {
        relPath: 'PORTING_BLUEPRINT.md',
        content: `# ${safeName} — Electron -> Capacitor Android Blueprint

1. Move UI bundle output into \`dist/\`.
2. Replace direct \`node:fs\`, \`node:child_process\`, and \`BrowserWindow\` calls with \`android-shims/native-bridge.ts\` + Capacitor plugins.
3. Run \`npx cap add android && npx cap sync android\` and build APK via Gradle.
`
      }
    ];
  }

  if (strategy === 'buildozer-kivy') {
    return [
      {
        relPath: 'buildozer.spec',
        content: `[app]
title = ${safeName}
package.name = ${safeName.toLowerCase()}
package.domain = dev.portforge
source.dir = .
source.include_exts = py,png,jpg,kv,atlas,json
version = 1.0.0
requirements = python3,kivy
orientation = landscape
fullscreen = 0

[buildozer]
log_level = 2

[app:android]
android.archs = arm64-v8a
android.api = 34
android.minapi = 24
android.permissions = INTERNET
`
      },
      {
        relPath: 'PORTING_BLUEPRINT.md',
        content: `# ${safeName} — Python -> Android APK (Buildozer / Kivy) Blueprint

1. Replace desktop-only GUI (\`tkinter\` / \`PyQt\`) with Kivy or BeeWare Toga widgets.
2. Adjust \`requirements\` in \`buildozer.spec\` with pure-Python wheels or python-for-android recipes.
3. Build via \`buildozer android debug\` on Linux/WSL2 and inspect \`adb logcat\` crashes with \`port-forge diagnose\`.
`
      }
    ];
  }

  if (strategy === 'godot-android-export' || strategy === 'unity-android-export') {
    const isGodot = strategy === 'godot-android-export';
    return [
      {
        relPath: 'export_android.sh',
        content: isGodot
          ? `#!/usr/bin/env bash
set -euo pipefail
godot --headless --export-debug "Android" "./build/${safeName}-debug.apk"
`
          : `#!/usr/bin/env bash
set -euo pipefail
Unity -quit -batchmode -projectPath . -buildTarget Android -executeMethod PortForgeBuild.BuildAndroidApk
`
      },
      {
        relPath: 'PORTING_BLUEPRINT.md',
        content: `# ${safeName} — ${isGodot ? 'Godot' : 'Unity'} Headless Android APK Blueprint

1. Ensure \`arm64-v8a\` IL2CPP / Android export template is installed.
2. Switch desktop input bindings to touch + gamepad actions.
3. Prefer Vulkan (or GLES3 on legacy Mali) and verify shader pre-warming on target device.
`
      }
    ];
  }

  const resolvedOracle = oracle || recommendRuntime({ inspection });
  return [
    {
      relPath: 'winlator.container.json',
      content: JSON.stringify(resolvedOracle.containerPreset, null, 2)
    },
    {
      relPath: 'dxvk.conf',
      content: `${resolvedOracle.dxvkConf}\n`
    },
    {
      relPath: 'PORTING_BLUEPRINT.md',
      content: `# ${safeName} — Winlator Container Preset Blueprint

- **SoC Profile:** ${resolvedOracle.socProfile.name}
- **Runtime Fork:** ${resolvedOracle.runtimeFork.name}
- **Translator:** ${resolvedOracle.translator}
- **Graphics Driver:** ${resolvedOracle.graphicsDriver}
- **DX Wrapper:** ${resolvedOracle.graphicsWrapper}
- **Launch Args:** ${resolvedOracle.launchArgs.join(' ') || '(none)'}

## Warnings
${resolvedOracle.warnings.map((w) => `- ${w}`).join('\n') || '- None'}
`
    }
  ];
}

function generateScaffold({
  strategy,
  outputDir,
  appName = 'PortedApp',
  inspection = null,
  soc = 'adreno-7xx',
  runtime = 'winlator-cmod',
  goal = 'balanced',
  overwrite = false
} = {}) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`Unsupported scaffold strategy "${strategy}". Expected one of: ${STRATEGIES.join(', ')}`);
  }
  if (!outputDir || typeof outputDir !== 'string') {
    throw new Error('outputDir is required');
  }
  const absOut = path.resolve(outputDir);
  fs.mkdirSync(absOut, { recursive: true });

  const oracle = recommendRuntime({ inspection, soc, runtime, goal });
  const files = buildFilesForStrategy({ strategy, appName, inspection, oracle });

  const written = [];
  const skipped = [];
  for (const file of files) {
    const dest = safeJoin(absOut, file.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && !overwrite) {
      skipped.push(file.relPath);
      continue;
    }
    fs.writeFileSync(dest, file.content, 'utf8');
    written.push(file.relPath);
  }

  return {
    strategy,
    outputDir: absOut,
    appName,
    writtenFiles: written,
    skippedFiles: skipped
  };
}

module.exports = {
  STRATEGIES,
  generateScaffold,
  buildFilesForStrategy,
  sanitizeAppId
};
