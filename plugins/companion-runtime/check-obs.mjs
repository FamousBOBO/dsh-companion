import { p2Observability } from './lib/observability.mjs';
import { openRuntimeDb } from './lib/db.mjs';
const db = openRuntimeDb({ file: ':memory:', now: () => 1 });
const out = p2Observability(db, { scopeKey: '', now: 1, agendaPublication: { via: 'provide', verified: true } });
console.log('keys', Object.keys(out.groups.reminders));
console.log('metrics', Object.keys(out.groups.reminders.metrics));
console.log('publication', JSON.stringify(out.groups.reminders.metrics.publication));
