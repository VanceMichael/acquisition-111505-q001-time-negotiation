import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export class Archive {
  constructor(directory) {
    this.directory = directory;
    this.tail = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'blobs'), { recursive: true });
    await mkdir(join(this.directory, 'receipts'), { recursive: true });
    await mkdir(join(this.directory, 'journal'), { recursive: true });
    return this;
  }
  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx');
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async store(raw) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const sha256 = digest(bytes);
    const operation = async () => {
      await this.atomic(join(this.directory, 'blobs', sha256), bytes);
      return sha256;
    };
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  receiptPath(source, identity) {
    const key = digest(Buffer.from(JSON.stringify([source, identity])));
    return { key, path: join(this.directory, 'receipts', `${key}.json`) };
  }
  async accept(source, identity, data, raw, options = {}) {
    const operation = async () => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const sha256 = digest(bytes);
      await this.atomic(join(this.directory, 'blobs', sha256), bytes);
      const { key, path } = this.receiptPath(source, identity);
      let previous = { source, identity, versions: [] };
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const encoded = JSON.stringify(data);
      const fingerprint = typeof options.fingerprint === 'string' ? options.fingerprint : null;
      const existing = fingerprint
        ? previous.versions.find(item => item.fingerprint === fingerprint)
        : previous.versions.find(item => item.sha256 === sha256 && JSON.stringify(item.data) === encoded);
      if (existing) {
        if (options.observeAt) {
          existing.observations = [...(existing.observations || []), options.observeAt];
          await this.atomic(path, Buffer.from(JSON.stringify(previous)));
        }
        return { receipt: key, version: existing.version, duplicate: true, sha256, fingerprint, observations: existing.observations || [] };
      }
      const version = previous.versions.length + 1;
      const record = { version, sha256, data, receivedAt: new Date().toISOString() };
      if (fingerprint) {
        record.fingerprint = fingerprint;
        record.observations = options.observeAt ? [options.observeAt] : [];
      }
      previous.versions.push(record);
      await this.atomic(path, Buffer.from(JSON.stringify(previous)));
      return { receipt: key, version, duplicate: false, sha256, fingerprint, observations: record.observations || [] };
    };
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  async list() {
    await this.tail;
    const names = (await readdir(join(this.directory, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory, 'receipts', name), 'utf8'))));
  }
  async appendResolution(scope, build) {
    const operation = async () => {
      const key = digest(Buffer.from(JSON.stringify([scope.source, scope.original, scope.date])));
      const path = join(this.directory, 'journal', `${key}.json`);
      let previous = { scope, checks: [] };
      try { previous = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const check = { at: new Date().toISOString(), ...build(previous.checks.at(-1) || null) };
      previous.checks.push(check);
      await this.atomic(path, Buffer.from(JSON.stringify(previous)));
      return { key, count: previous.checks.length, check };
    };
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  async resolutions() {
    await this.tail;
    const names = (await readdir(join(this.directory, 'journal'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory, 'journal', name), 'utf8'))));
  }
  async resolution(scope) {
    await this.tail;
    const key = digest(Buffer.from(JSON.stringify([scope.source, scope.original, scope.date])));
    try { return JSON.parse(await readFile(join(this.directory, 'journal', `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async bytes(sha256) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('摘要格式无效');
    return readFile(join(this.directory, 'blobs', sha256));
  }
}
