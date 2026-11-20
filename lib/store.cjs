'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function defaultForgeHome() {
  return process.env.PORT_FORGE_HOME || path.join(os.homedir(), '.port-forge');
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

class ForgeStore {
  constructor(baseDir = defaultForgeHome()) {
    this.baseDir = path.resolve(baseDir);
    this.projectsDir = path.join(this.baseDir, 'projects');
    fs.mkdirSync(this.projectsDir, { recursive: true });
  }

  projectPath(projectId) {
    if (!projectId || !/^[A-Za-z0-9_-]{4,64}$/.test(projectId)) {
      throw new Error(`Invalid projectId: ${projectId}`);
    }
    return path.join(this.projectsDir, `${projectId}.json`);
  }

  createProject({ name, targetPath, inspection, oracle = null, scaffold = null, diagnoses = [] }) {
    const id = `pf_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const record = {
      id,
      name: name || path.basename(targetPath || 'project'),
      targetPath: targetPath ? path.resolve(targetPath) : null,
      createdAt: now,
      updatedAt: now,
      inspection,
      oracle,
      scaffold,
      diagnoses
    };
    atomicWriteJson(this.projectPath(id), record);
    return record;
  }

  readProject(projectId) {
    const p = this.projectPath(projectId);
    if (!fs.existsSync(p)) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  updateProject(projectId, patch) {
    const current = this.readProject(projectId);
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    };
    atomicWriteJson(this.projectPath(projectId), updated);
    return updated;
  }

  appendDiagnosis(projectId, diagnosis) {
    const current = this.readProject(projectId);
    const diagnoses = [...(current.diagnoses || []), { at: new Date().toISOString(), ...diagnosis }];
    return this.updateProject(projectId, { diagnoses });
  }

  listProjects() {
    if (!fs.existsSync(this.projectsDir)) return [];
    const files = fs.readdirSync(this.projectsDir).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.projectsDir, file), 'utf8'));
        out.push({
          id: data.id,
          name: data.name,
          kind: data.inspection?.kind || null,
          stack: data.inspection?.stack || data.inspection?.format || null,
          strategy: data.inspection?.recommendedStrategy || null,
          readinessScore: data.inspection?.readinessScore ?? null,
          updatedAt: data.updatedAt
        });
      } catch {
        // skip corrupted entries safely
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

module.exports = {
  ForgeStore,
  defaultForgeHome,
  atomicWriteJson
};
