import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_RECORDS = 500;

export class ConsoleAudit {
  constructor(file = null) {
    this.file = file;
    this.records = [];
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) this.records = parsed.slice(0, MAX_RECORDS);
      } catch {
        this.records = [];
      }
    }
  }

  record(entry) {
    const record = {
      id: `cau_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      at: new Date().toISOString(),
      actor: entry.actor || 'anonymous',
      source: entry.source || 'direct',
      ip: entry.ip || 'local',
      via: entry.via || 'none',
      action: entry.action || 'console.request',
      project: entry.project || null,
      detail: entry.detail || '',
      ok: entry.ok !== false,
      tone: entry.ok === false ? 'error' : 'info',
    };
    this.records.unshift(record);
    if (this.records.length > MAX_RECORDS) this.records.length = MAX_RECORDS;
    this.save();
    return record;
  }

  list(limit = 100) {
    return this.records.slice(0, Math.max(0, Number(limit) || 0));
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.records, null, 2)}\n`);
  }
}
