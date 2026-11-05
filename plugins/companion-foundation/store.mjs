import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One process owns this store; the desktop profile lock excludes a second host.
export function createStore(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  const load = () => {
    if (!fs.existsSync(file)) return { schemaVersion: 1, revision: 0, memories: {}, events: [] };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) ||
        !state.memories || typeof state.memories !== 'object' || Array.isArray(state.memories) ||
        !Array.isArray(state.events)) throw new Error('Invalid companion state; restore a verified backup.');
    return state;
  };
  const commit = (state) => {
    state.revision += 1;
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.previous');
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  return {
    listMemories() { return Object.values(load().memories); },
    status() {
      const state = load();
      return { schemaVersion: 1, revision: state.revision, memoryCount: Object.keys(state.memories).length,
        eventCount: state.events.length, timeZone: 'Asia/Shanghai', channels: { desktop: true, qq: false, bilibili: false } };
    },
    recall(query = '') {
      if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid memory query.');
      const needle = query.toLocaleLowerCase();
      return Object.values(load().memories).filter(row => `${row.key}\n${row.value}`.toLocaleLowerCase().includes(needle)).slice(-20);
    },
    remember(key, value, userId = undefined) {
      if (typeof key !== 'string' || !/^[\p{L}\p{N}_. -]{1,80}$/u.test(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid memory key.');
      if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Invalid memory value.');
      const state = load();
      if (!Object.hasOwn(state.memories, key) && Object.keys(state.memories).length >= 1000) throw new Error('Memory capacity reached.');
      state.memories[key] = { key, value, updatedAt: new Date().toISOString(), source: 'desktop', persona: 'bot', ...(userId ? { userId } : {}) };
      commit(state);
      return state.memories[key];
    },
    events(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid event limit.');
      return load().events.slice(-limit);
    },
    record(source, text, userId = undefined) {
      if (!['desktop', 'qq', 'bilibili', 'system'].includes(source)) throw new Error('Invalid event source.');
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Invalid event text.');
      const state = load();
      const event = { id: randomUUID(), at: new Date().toISOString(), source, text, persona: 'bot', ...(userId ? { userId } : {}) };
      state.events.push(event);
      if (state.events.length > 500) throw new Error('Event capacity reached; archive events before continuing.');
      commit(state);
      return event;
    },
  };
}
