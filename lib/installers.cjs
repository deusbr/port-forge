'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKILL_NAME = 'port-forge';
const SERVER_NAME = 'port-forge';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function readTextSafe(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) throw new Error(`Refusing symlink config path: ${filePath}`);
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) {
    throw new Error(`Invalid or oversized config file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function getClientTargets({
  home = os.homedir(),
  appdata = process.env.APPDATA || path.join(home, '.config'),
  platform = process.platform
} = {}) {
  const claudeDesktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(appdata, 'Claude', 'claude_desktop_config.json');

  return [
    {
      id: 'codex',
      name: 'Codex',
      format: 'toml',
      configPath: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
      skillDir: path.join(home, '.agents', 'skills', SKILL_NAME),
      extraSkillDirs: [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills', SKILL_NAME)]
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      format: 'json',
      configPath: path.join(home, '.gemini', 'settings.json'),
      skillDir: path.join(home, '.gemini', 'skills', SKILL_NAME)
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      format: 'json',
      configPath: path.join(home, '.claude.json'),
      skillDir: path.join(home, '.claude', 'skills', SKILL_NAME)
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      format: 'json',
      configPath: claudeDesktop,
      skillDir: null
    }
  ];
}

function tomlSectionSpan(text, serverName) {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^\\[mcp_servers\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]\\s*$`, 'm');
  const match = headerRe.exec(text);
  if (!match) return null;
  const start = match.index;
  const after = text.slice(start + match[0].length);
  const nextTop = after.search(/\r?\n\[(?!mcp_servers\.(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\.env\])[^\]]+\]/);
  const end = nextTop === -1 ? text.length : start + match[0].length + nextTop + 1;
  return [start, end];
}

function formatTomlServerSection(serverName, def) {
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(def.command)}`,
    `args = ${JSON.stringify(def.args || [])}`
  ];
  if (def.env && Object.keys(def.env).length > 0) {
    lines.push('', `[mcp_servers.${serverName}.env]`);
    for (const [k, v] of Object.entries(def.env)) {
      lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function upsertTomlMcp(filePath, serverName, def) {
  const original = readTextSafe(filePath);
  const block = formatTomlServerSection(serverName, def);
  const span = tomlSectionSpan(original, serverName);
  let next;
  if (span) {
    next = `${original.slice(0, span[0])}${block}${original.slice(span[1])}`;
  } else {
    const trimmed = original.trimEnd();
    next = trimmed ? `${trimmed}\n\n${block}` : block;
  }
  atomicWriteText(filePath, next);
}

function upsertJsonMcp(filePath, serverName, def) {
  const original = readTextSafe(filePath);
  const parsed = original.trim() ? JSON.parse(original) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  parsed.mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  parsed.mcpServers[serverName] = {
    command: def.command,
    args: def.args || [],
    ...(def.env ? { env: def.env } : {})
  };
  atomicWriteText(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function installSkillToDir(skillSourceDir, destDir) {
  const src = path.join(skillSourceDir, 'SKILL.md');
  if (!fs.existsSync(src)) {
    throw new Error(`Missing skill source: ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  atomicWriteText(path.join(destDir, 'SKILL.md'), fs.readFileSync(src, 'utf8'));
}

function buildMcpDefinition({ repoRoot, nodeBin = process.execPath } = {}) {
  return {
    command: nodeBin,
    args: [path.join(repoRoot, 'bin', 'mcp-server.cjs')]
  };
}

function installToClients({
  clients = ['codex', 'gemini', 'claude-code', 'claude-desktop'],
  repoRoot = path.resolve(__dirname, '..'),
  envPaths = {},
  nodeBin = process.execPath
} = {}) {
  const targets = getClientTargets(envPaths);
  const def = buildMcpDefinition({ repoRoot, nodeBin });
  const skillSrc = path.join(repoRoot, 'skill');
  const results = [];

  for (const id of clients) {
    const target = targets.find((t) => t.id === id);
    if (!target) {
      results.push({ id, ok: false, error: `Unknown client: ${id}` });
      continue;
    }
    try {
      if (target.format === 'toml') {
        upsertTomlMcp(target.configPath, SERVER_NAME, def);
      } else {
        upsertJsonMcp(target.configPath, SERVER_NAME, def);
      }
      const installedSkills = [];
      for (const sDir of [target.skillDir, ...(target.extraSkillDirs || [])].filter(Boolean)) {
        installSkillToDir(skillSrc, sDir);
        installedSkills.push(path.join(sDir, 'SKILL.md'));
      }
      results.push({ id, name: target.name, ok: true, configPath: target.configPath, skills: installedSkills });
    } catch (err) {
      results.push({ id, name: target.name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  SKILL_NAME,
  SERVER_NAME,
  getClientTargets,
  upsertTomlMcp,
  upsertJsonMcp,
  installSkillToDir,
  installToClients
};
