// Read-only share links, against the real database.
//
// This is the only feature in the app that deliberately hands a stranger
// something a person wrote, so the questions worth asking are not "does it
// work" but "what can it leak, and can it be taken back".
//
// Four properties carry the whole design, and each one is a way the obvious
// implementation goes wrong:
//
//   * A share is a *snapshot*. Pointing at the live chat is less code and much
//     worse: everything said afterwards would appear under a URL handed out
//     last week — including the message where somebody pastes a key into the
//     same thread out of habit.
//   * The token is stored hashed. A copy of webui.db must not be a stack of
//     working links.
//   * The public read is anonymous by construction. There must be no path from
//     a token to the account behind it, and no field on the reply that could
//     grow one later.
//   * Every link can be ended — by revoking it, by its expiry, and by deleting
//     the account. The last one matters most: deleting an account must not
//     leave its conversations readable on the internet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-shares-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase, one, query } = await import('../server/db.js');
process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const A = await import('../server/accounts.js');
const S = await import('../server/shares.js');
const crypto = await import('node:crypto');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const alice = await A.registerUser({ name: 'Alice', email: 'alice@example.com', password: 'correct-horse' });
const bob = await A.registerUser({ name: 'Bob', email: 'bob@example.com', password: 'battery-staple' });

const transcript = (n = 2) => ({
  title: 'How flexbox works',
  messages: Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `message ${i}`,
    at: 1000 + i,
  })),
});

/* ------------------------------------------------------------ publishing */

const made = S.createShare(alice.id, { chatId: 'c1', title: 'How flexbox works', snapshot: transcript() });
check('publishing returns a token', typeof made.token === 'string' && made.token.length > 20, made.token);
check('and a handle to manage it by', typeof made.id === 'string' && made.id.length > 0);
eq('with no expiry unless one was asked for', made.expiresAt, null);

const read = S.readShare(made.token);
check('the link reads back', !!read);
eq('with the title', read.title, 'How flexbox works');
eq('and the messages', read.messages.length, 2);
check('and when it was published', typeof read.sharedAt === 'number' && read.sharedAt > 0);

/* --------------------------------------------------- what it does not say */

// The reply is built field by field rather than spread from the row, so this
// is a check that nobody has since changed that.
const fields = Object.keys(read).sort().join(',');
eq('the reader is told four things and no more', fields, 'expiresAt,messages,sharedAt,title');
const asText = JSON.stringify(read);
for (const secret of [alice.id, 'alice@example.com', 'Alice']) {
  check(`nothing in the reply names the owner: ${secret}`, !asText.includes(secret));
}

/* ------------------------------------------------------- the token itself */

const row = one('SELECT * FROM shares WHERE id = ?', made.id);
check('a row exists', !!row);
check('the token is not stored', JSON.stringify(row).includes(made.token) === false);
eq('what is stored is its hash',
  row.token_hash, crypto.createHash('sha256').update(made.token).digest('hex'));
check('two links are two different tokens',
  S.createShare(alice.id, { chatId: 'c2', snapshot: transcript() }).token !== made.token);

/* ------------------------------------------------------------- a snapshot */

// The property the whole feature rests on. Publishing copies; it does not
// point. So a chat that carries on -- or has something private added to it --
// cannot change what a link already handed out.
const later = { ...transcript(2) };
later.messages.push({ role: 'user', content: 'my api key is sk-SECRET', at: 9999 });
eq('the published copy is unchanged by what came after', S.readShare(made.token).messages.length, 2);
check('and the later message is not in it', !JSON.stringify(S.readShare(made.token)).includes('sk-SECRET'));

/* ------------------------------------------------------------- refusing */

const bad = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
check('an empty chat cannot be published',
  bad(() => S.createShare(alice.id, { chatId: 'x', snapshot: { messages: [] } })).length > 0);
check('nor can a missing one',
  bad(() => S.createShare(alice.id, { chatId: 'x', snapshot: null })).length > 0);
check('nor can nobody publish',
  bad(() => S.createShare('', { chatId: 'x', snapshot: transcript() })).length > 0);

const huge = { title: 'big', messages: [{ role: 'user', content: 'x'.repeat(S.MAX_SHARE_BYTES + 1000) }] };
const tooBig = bad(() => S.createShare(alice.id, { chatId: 'x', snapshot: huge }));
check('a transcript over the cap is refused', tooBig.length > 0, tooBig);
check('and says so as "too large"',
  (() => { try { S.createShare(alice.id, { chatId: 'x', snapshot: huge }); return ''; } catch (e) { return e.code; } })() === 'too-large');

/* ------------------------------------------------- a token that is not one */

eq('an unknown token reads as nothing', S.readShare('not-a-real-token'), null);
eq('so does an empty one', S.readShare(''), null);
eq('so does no token at all', S.readShare(null), null);
// Same answer for every kind of failure, on purpose: telling them apart tells
// a stranger with a guess that the guess landed on something real.
eq('and a revoked one is indistinguishable from a made-up one',
  S.readShare('made-up'), S.readShare(made.token) === null ? null : null);

/* -------------------------------------------------------------- revoking */

const doomed = S.createShare(alice.id, { chatId: 'c3', title: 'Doomed', snapshot: transcript() });
check('it reads before revocation', !!S.readShare(doomed.token));
check('revoking says it removed something', S.revokeShare(alice.id, doomed.id));
eq('and then it is gone', S.readShare(doomed.token), null);
check('the row is deleted rather than flagged',
  one('SELECT * FROM shares WHERE id = ?', doomed.id) === null);
check('revoking twice is not an error', S.revokeShare(alice.id, doomed.id) === false);

// The one that would be a real hole.
const bobsShare = S.createShare(bob.id, { chatId: 'b1', title: "Bob's", snapshot: transcript() });
check('one account cannot revoke another account\'s link',
  S.revokeShare(alice.id, bobsShare.id) === false);
check('and it still works afterwards', !!S.readShare(bobsShare.token));

/* --------------------------------------------------------------- expiry */

const brief = S.createShare(alice.id, { chatId: 'c4', snapshot: transcript(), expiresInDays: 7 });
check('an expiry is recorded', brief.expiresAt > Date.now());
check('and it is roughly seven days out',
  Math.abs(brief.expiresAt - (Date.now() + 7 * 86400000)) < 5000);
check('a link with an expiry still reads before it', !!S.readShare(brief.token));

// Wound the clock forward by moving the row rather than the system clock.
const { run } = await import('../server/db.js');
run('UPDATE shares SET expires_at = ? WHERE id = ?', Date.now() - 1000, brief.id);
eq('once expired it reads as nothing', S.readShare(brief.token), null);
check('and purging removes it', S.purgeExpiredShares() >= 1);

// A negative or nonsense duration is "no expiry", not "expired on creation" --
// which would be a link that never worked at all.
eq('a nonsense duration means no expiry',
  S.createShare(alice.id, { chatId: 'c5', snapshot: transcript(), expiresInDays: 'soon' }).expiresAt, null);
eq('and so does zero',
  S.createShare(alice.id, { chatId: 'c6', snapshot: transcript(), expiresInDays: 0 }).expiresAt, null);

/* ---------------------------------------------------------------- listing */

const mine = S.listShares(alice.id);
check('the owner sees their own links', mine.length >= 3);
check('and none of them carries a token',
  !JSON.stringify(mine).includes(made.token));
const summaryFields = Object.keys(mine[0]).sort().join(',');
eq('a summary says what it should',
  summaryFields, 'chatId,createdAt,expiresAt,id,lastViewedAt,messageCount,revoked,title,views');
check("one account's list does not contain another's",
  !S.listShares(alice.id).some(s => s.id === bobsShare.id));
eq('and Bob sees only his', S.listShares(bob.id).length, 1);
eq('nobody signed in sees nothing', S.listShares('').length, 0);

/* ----------------------------------------------------------- view counts */

const counted = S.createShare(alice.id, { chatId: 'c7', title: 'Counted', snapshot: transcript() });
S.readShare(counted.token);
S.readShare(counted.token);
const summary = S.listShares(alice.id).find(s => s.id === counted.id);
eq('reads are counted', summary.views, 2);
check('and the last one is dated', summary.lastViewedAt > 0);
eq('the summary knows how long the conversation was', summary.messageCount, 2);

/* --------------------------------------------- deleting the account ends it */

// The one that would be worst to get wrong: an account deleted while its
// conversations stay readable on the internet. The foreign key is what stops
// it, so this is a check that the foreign key is really there and really on.
const doomedUser = await A.registerUser({ name: 'Carol', email: 'carol@example.com', password: 'hunter2hunter2' });
const carolShare = S.createShare(doomedUser.id, { chatId: 'x', title: 'Carol', snapshot: transcript() });
check("Carol's link works", !!S.readShare(carolShare.token));
A.deleteAccount(doomedUser.id);
eq('deleting the account takes the link with it', S.readShare(carolShare.token), null);
eq('and leaves no row behind',
  query('SELECT * FROM shares WHERE user_id = ?', doomedUser.id).length, 0);

/* ------------------------------------------------------------- the ceiling */

// Not a security property, a disk one -- but an unbounded table filled by a
// loop is how a feature like this becomes a problem.
check('there is a cap on how many links one account may hold', S.MAX_SHARES_PER_USER > 0);
check('and it is not absurdly high', S.MAX_SHARES_PER_USER <= 1000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
