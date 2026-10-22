import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSessions } from '../src/sessions.js';

test('sessions are hashed, individually revocable, expiring and invalidated by credential rotation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let time = 1_000_000_000_000;
  const now = () => time;
  const password = 'test-password-12345';
  const secret = 'test-secret-long-enough-for-session-signing';
  let store = createSessions(db, password, secret, now);
  try {
    const first = store.create();
    const second = store.create();
    assert.equal(store.authenticated(`session=${first}`), true);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sessions').all()).includes(first));
    assert.equal(store.authenticated(`session=${first.slice(0, -1)}x`), false);
    store.revoke(`session=${first}`);
    assert.equal(store.authenticated(`session=${first}`), false);
    assert.equal(store.authenticated(`session=${second}`), true);
    store = createSessions(db, password, secret, now);
    assert.equal(store.authenticated(`session=${second}`), true);
    store = createSessions(db, 'changed-password-12345', secret, now);
    assert.equal(store.authenticated(`session=${second}`), false);
    const third = store.create();
    store = createSessions(db, 'changed-password-12345', `${secret}-rotated`, now);
    assert.equal(store.authenticated(`session=${third}`), false);
    const idle = store.create();
    time += 2 * 3600_000;
    assert.equal(store.authenticated(`session=${idle}`), false, 'idle timeout is enforced by the server');
    const active = store.create();
    for (let hour = 1; hour < 12; hour++) {
      time += 3600_000;
      assert.equal(store.authenticated(`session=${active}`), true);
    }
    time += 3600_000;
    assert.equal(store.authenticated(`session=${active}`), false, 'absolute timeout applies even with activity');
    for (let i = 0; i < 25; i++) store.create();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 20);
  } finally { db.close(); }
});
