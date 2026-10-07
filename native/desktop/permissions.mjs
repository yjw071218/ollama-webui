// Permissions granted "always" (다시 묻지 않기), kept per server across restarts.
//
// A grant used to last only as long as the app was running, so copying an
// answer after every restart asked again for clipboard access. The reader can
// now say once that this server may always have it. Stored per server key, so
// a grant for one server never applies to another, and only for the
// permissions the request handler already supports.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'permissions.json';

const readAll = (dir) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

/** The permissions this server was always allowed, as a Set. */
export function loadGrants(dir, key, supported = []) {
  const list = readAll(dir)[key];
  return new Set((Array.isArray(list) ? list : []).filter(p => typeof p === 'string' && (!supported.length || supported.includes(p))));
}

/** Remember `permission` for this server. Never throws: a failed write only means asking again next time. */
export function rememberGrant(dir, key, permission) {
  try {
    const all = readAll(dir);
    const list = new Set(Array.isArray(all[key]) ? all[key] : []);
    list.add(permission);
    all[key] = [...list];
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, FILE + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, path.join(dir, FILE));
    return true;
  } catch { return false; }
}

/** Forget every "always" grant for this server. */
export function forgetGrants(dir, key) {
  try {
    const all = readAll(dir);
    if (!(key in all)) return true;
    delete all[key];
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(all, null, 2));
    return true;
  } catch { return false; }
}
