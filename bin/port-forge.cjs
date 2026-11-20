#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectTarget } = require('../lib/inspector.cjs');
const { recommendRuntime, SOC_PROFILES, RUNTIME_FORKS } = require('../lib/winlator-oracle.cjs');
const { generateScaffold, STRATEGIES } = require('../lib/scaffolder.cjs');
const { diagnoseLogText, diagnoseLogFile, probeAdb } = require('../lib/log-doctor.cjs');
const { ForgeStore, defaultForgeHome } = require('../lib/store.cjs');
const { createWebServer } = require('../lib/web.cjs');
const { installToClients } = require('../lib/installers.cjs');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 2 - 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp() {
  process.stdout.write(`port-forge v${require('../package.json').version}
Unified cross-platform porting studio (PC Apps / Windows Games / Xbox 360 Recomp -> Android)

Usage:
  port-forge inspect <targetPath> [--save] [--name <name>] [--json]
  port-forge oracle [--target <path>] [--soc <id>] [--runtime <id>] [--goal <balanced|stability|fps|battery>] [--json]
  port-forge scaffold --strategy <id> --out <dir> [--name <app>] [--target <path>] [--overwrite] [--json]
  port-forge diagnose (<logFile> | --text <logText>) [--json]
  port-forge adb [--json]
  port-forge projects [--json]
  port-forge web [--port 4380]
  port-forge install [--clients codex,gemini,claude-code,claude-desktop]
  port-forge mcp

SoCs: ${Object.keys(SOC_PROFILES).join(', ')}
Runtimes: ${Object.keys(RUNTIME_FORKS).join(', ')}
Strategies: ${STRATEGIES.join(', ')}
`);
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) {
    printHelp();
    return 0;
  }

  const store = new ForgeStore(defaultForgeHome());

  if (cmd === 'inspect') {
    const targetPath = positional[1] || flags.target;
    if (!targetPath) throw new Error('Missing <targetPath>');
    const inspection = inspectTarget(targetPath);
    let project = null;
    if (flags.save) {
      project = store.createProject({ name: flags.name, targetPath, inspection });
    }
    process.stdout.write(`${JSON.stringify(project ? { inspection, project } : inspection, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'oracle') {
    const targetPath = flags.target || positional[1];
    const inspection = targetPath ? inspectTarget(targetPath) : null;
    const oracle = recommendRuntime({
      inspection,
      soc: flags.soc || 'adreno-7xx',
      runtime: flags.runtime || 'winlator-cmod',
      goal: flags.goal || 'balanced'
    });
    process.stdout.write(`${JSON.stringify(oracle, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'scaffold') {
    const strategy = flags.strategy;
    const outputDir = flags.out;
    if (!strategy || !outputDir) throw new Error('Both --strategy and --out are required');
    const inspection = flags.target ? inspectTarget(flags.target) : null;
    const res = generateScaffold({
      strategy,
      outputDir,
      appName: flags.name || 'PortedApp',
      inspection,
      soc: flags.soc || 'adreno-7xx',
      runtime: flags.runtime || 'winlator-cmod',
      goal: flags.goal || 'balanced',
      overwrite: Boolean(flags.overwrite)
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'diagnose') {
    const res = flags.text
      ? diagnoseLogText(String(flags.text))
      : positional[1]
        ? diagnoseLogFile(positional[1])
        : (() => { throw new Error('Provide a <logFile> or --text'); })();
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'adb') {
    const res = await probeAdb();
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'projects') {
    process.stdout.write(`${JSON.stringify({ projects: store.listProjects() }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'install') {
    const clients = typeof flags.clients === 'string'
      ? flags.clients.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const res = installToClients({
      clients,
      repoRoot: path.resolve(__dirname, '..')
    });
    process.stdout.write(`${JSON.stringify({ installed: res }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'web') {
    const web = createWebServer({ store, port: Number(flags.port || 4380) });
    const info = await web.listen();
    process.stdout.write(`Port-Forge Workbench listening at ${info.url}\n`);
    return new Promise(() => {});
  }

  if (cmd === 'mcp') {
    require('./mcp-server.cjs');
    return new Promise(() => {});
  }

  throw new Error(`Unknown command: ${cmd}`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
