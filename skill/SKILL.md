---
name: port-forge
description: Analyze Windows PE (.exe/.dll), Xbox 360 (.xex), or PC source repositories, generate Android NDK/SDL2/Capacitor/Buildozer/XenonRecomp scaffolds, recommend SoC-specific Winlator/Box64/DXVK presets, and diagnose crash/build logs.
---

# Port-Forge

Use this skill whenever the user wants to port a PC desktop app, PC game, or Xbox 360 static recompilation target to Android (native APK or optimized Winlator container), or debug an Android porting / Box64 / DXVK crash log.

## Legal & Scope Rule
- Operate strictly on user-owned source code, binaries, or logs provided locally.
- Never generate, download, or bundle copyrighted ROMs, BIOS files, or decryption keys.

## Workflow
1. **Inspect first (`port_inspect_target`):**
   - Point at a local `.exe`/`.dll`, `.xex`, or source folder (`C++/Win32/DirectX`, `Electron`, `Python`, `Godot`, `Unity`, `XenonRecomp`).
   - Review detected graphics/audio/input APIs, blockers (anti-cheat, D3D12 timeline semaphores, Win32 HWND, Big-Endian VMX128), and `readinessScore`.
2. **Optimize runtime (`port_recommend_runtime`) when targeting Winlator/Android translation:**
   - Match the user's Android SoC (`adreno-7xx`, `adreno-6xx`, `mali-immortalis`, `xclipse-rdna`) and fork (`winlator-cmod`, `winlator-bionic`, `winlator-ludashi`, `winlator-frost`).
   - Apply emitted `dxvk.conf`, Box64/FEX variables, and launch flags (e.g. `-force-gfx-direct` for Unity).
3. **Generate project scaffold (`port_generate_scaffold`):**
   - Pick the matching strategy (`android-ndk-sdl2`, `xenon-recomp-arm64`, `capacitor-android`, `buildozer-kivy`, `godot-android-export`, `unity-android-export`, or `winlator-container`).
4. **Diagnose failures (`port_diagnose_log` & `port_adb_probe`):**
   - Feed `adb logcat`, `WINEDEBUG`, `BOX64`, Vulkan, or CMake/Gradle output into `port_diagnose_log` before changing settings blindly.
