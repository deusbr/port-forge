#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { inspectTarget } = require('../lib/inspector.cjs');
const { recommendRuntime, SOC_PROFILES, RUNTIME_FORKS } = require('../lib/winlator-oracle.cjs');
const { generateScaffold, STRATEGIES } = require('../lib/scaffolder.cjs');
const { diagnoseLogText, diagnoseLogFile, probeAdb } = require('../lib/log-doctor.cjs');
const { ForgeStore, defaultForgeHome } = require('../lib/store.cjs');
const { createWebServer } = require('../lib/web.cjs');

const store = new ForgeStore(defaultForgeHome());
let webInstance = null;
let webInfo = null;

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const TOOLS = [
  {
    name: 'port_inspect_target',
    description: 'Inspect a local Windows PE (.exe/.dll), Xbox 360 (.xex), or source directory (C++/Win32/DX, Electron, Python, Godot, Unity, XenonRecomp) to extract APIs, blockers, and porting readiness.',
    inputSchema: {
      type: 'object',
      required: ['targetPath'],
      properties: {
        targetPath: { type: 'string', description: 'Absolute path to local binary or project directory.' },
        saveProject: { type: 'boolean', description: 'Persist project record in local Port-Forge store.' },
        name: { type: 'string', description: 'Optional project display name.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'port_recommend_runtime',
    description: 'Generate an optimized Winlator/Box64/FEX/Turnip/DXVK runtime configuration, dxvk.conf, and launch flags for a target Android SoC.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'Optional path to inspect first.' },
        projectId: { type: 'string', description: 'Optional existing projectId.' },
        soc: { type: 'string', enum: Object.keys(SOC_PROFILES) },
        runtime: { type: 'string', enum: Object.keys(RUNTIME_FORKS) },
        goal: { type: 'string', enum: ['balanced', 'stability', 'fps', 'battery'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'port_generate_scaffold',
    description: 'Generate Android porting project files (NDK+SDL2+Vulkan CMake, XenonRecomp ARM64 shims, Capacitor, Buildozer, Godot/Unity headless export, or Winlator preset).',
    inputSchema: {
      type: 'object',
      required: ['strategy', 'outputDir'],
      properties: {
        strategy: { type: 'string', enum: STRATEGIES },
        outputDir: { type: 'string', description: 'Destination directory for scaffold files.' },
        appName: { type: 'string' },
        targetPath: { type: 'string', description: 'Optional source/binary path to enrich blueprint.' },
        soc: { type: 'string', enum: Object.keys(SOC_PROFILES) },
        runtime: { type: 'string', enum: Object.keys(RUNTIME_FORKS) },
        goal: { type: 'string', enum: ['balanced', 'stability', 'fps', 'battery'] },
        overwrite: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'port_diagnose_log',
    description: 'Analyze crash or build logs (logcat, WINEDEBUG, DXVK, Box64, Vulkan validation, CMake/NDK) and return concrete fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        logText: { type: 'string', description: 'Raw log lines to analyze.' },
        filePath: { type: 'string', description: 'Path to a local log file.' },
        projectId: { type: 'string', description: 'Optional projectId to record diagnosis.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'port_adb_probe',
    description: 'Probe connected Android devices/emulators via adb (if installed on PATH) and report ABI and SoC metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'port_list_projects',
    description: 'List saved porting projects and readiness scores in the local Port-Forge workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'port_get_project',
    description: 'Read full inspection, runtime oracle preset, scaffold metadata, and log diagnoses for a saved projectId.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'port_start_web',
    description: 'Start the local Port-Forge Web Workbench on 127.0.0.1 and return its URL.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1024, maximum: 65535 }
      },
      additionalProperties: false
    }
  }
];

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'port_inspect_target': {
      const inspection = inspectTarget(args.targetPath);
      let project = null;
      if (args.saveProject !== false) {
        project = store.createProject({
          name: args.name,
          targetPath: args.targetPath,
          inspection
        });
      }
      return { inspection, project };
    }
    case 'port_recommend_runtime': {
      let inspection = null;
      if (args.projectId) {
        inspection = store.readProject(args.projectId).inspection;
      } else if (args.targetPath) {
        inspection = inspectTarget(args.targetPath);
      }
      const oracle = recommendRuntime({
        inspection,
        soc: args.soc || 'adreno-7xx',
        runtime: args.runtime || 'winlator-cmod',
        goal: args.goal || 'balanced'
      });
      if (args.projectId) {
        store.updateProject(args.projectId, { oracle });
      }
      return { oracle };
    }
    case 'port_generate_scaffold': {
      const inspection = args.targetPath ? inspectTarget(args.targetPath) : null;
      const scaffold = generateScaffold({
        strategy: args.strategy,
        outputDir: args.outputDir,
        appName: args.appName || 'PortedApp',
        inspection,
        soc: args.soc || 'adreno-7xx',
        runtime: args.runtime || 'winlator-cmod',
        goal: args.goal || 'balanced',
        overwrite: Boolean(args.overwrite)
      });
      return { scaffold };
    }
    case 'port_diagnose_log': {
      const diagnosis = args.filePath
        ? diagnoseLogFile(args.filePath)
        : diagnoseLogText(args.logText);
      if (args.projectId) {
        store.appendDiagnosis(args.projectId, diagnosis);
      }
      return { diagnosis };
    }
    case 'port_adb_probe':
      return probeAdb();
    case 'port_list_projects':
      return { projects: store.listProjects(), webUrl: webInfo?.url || null };
    case 'port_get_project':
      return { project: store.readProject(args.projectId), webUrl: webInfo?.url || null };
    case 'port_start_web': {
      if (!webInstance) {
        webInstance = createWebServer({ store, port: args.port || 4380 });
        webInfo = await webInstance.listen();
      }
      return { ok: true, ...webInfo };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    return respond(msg.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'port-forge', version: require('../package.json').version },
      capabilities: { tools: {} }
    });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    return respond(msg.id, { tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {};
    try {
      const payload = await handleToolCall(name, args);
      return respond(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
      });
    } catch (err) {
      if (err.code === -32601) {
        return respondError(msg.id, -32601, err.message);
      }
      return respond(msg.id, {
        isError: true,
        content: [{ type: 'text', text: err.message }]
      });
    }
  }
  if (msg.id !== undefined) {
    respondError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg).catch((err) => {
        if (msg && msg.id !== undefined) respondError(msg.id, -32603, err.message);
      });
    } catch {
      // Ignore malformed lines cleanly
    }
  });
}

module.exports = { TOOLS, handleMessage, handleToolCall };
