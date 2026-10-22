import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const LIFETIME = 12 * 3600_000;
const IDLE_TIMEOUT = 2 * 3600_000;
export const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSessions(db: DatabaseSync, password: string, secret: string, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
  const credentialVersion = sign(`credentials:${password}`);
  // Rotating either credential invalidates existing sessions, including after a restart.
  if (db.prepare("SELECT value FROM settings WHERE key='credentials_version'").get()?.value !== credentialVersion) {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM sessions');
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('credentials_version', ?)").run(credentialVersion);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function sessionId(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (!token || token.length > 200) return;
    const parts = token.split('.');
    if (parts.length !== 3) return;
    const [expires, nonce, signature] = parts;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry <= now() || !/^[a-f0-9]{64}$/.test(nonce) || !sameSecret(signature, sign(`${expires}.${nonce}`))) return;
    const id = hash(token);
    const row = db.prepare('SELECT expires, last_seen FROM sessions WHERE token_hash=?').get(id);
    if (!row) return;
    if (Number(row.expires) <= now() || Number(row.last_seen) <= now() - IDLE_TIMEOUT) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(id);
      return;
    }
    if (now() - Number(row.last_seen) >= 60_000) db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now(), id);
    return id;
  }
  return {
    authenticated: (cookie?: string) => Boolean(sessionId(cookie)),
    create() {
      const expires = now() + LIFETIME;
      const payload = `${expires}.${randomBytes(32).toString('hex')}`;
      const token = `${payload}.${sign(payload)}`;
      db.prepare('DELETE FROM sessions WHERE expires<=? OR last_seen<=?').run(now(), now() - IDLE_TIMEOUT);
      // Keep at most twenty active sessions for this single administrator.
      db.exec('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY last_seen DESC LIMIT -1 OFFSET 19)');
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), expires, now());
      return token;
    },
    revoke(cookie?: string) {
      const id = sessionId(cookie);
      if (id) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(id);
    }
  };
}
