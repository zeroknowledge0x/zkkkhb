// Keep the Hermes skill in this repo, the copy Hermes loads, and the config-backup
// snapshot in lockstep.
//
//   node scripts/sync-skill.mjs --check      report differences, change nothing
//   node scripts/sync-skill.mjs --to-local   repo  -> ~/.hermes/skills/... (install/refresh)
//   node scripts/sync-skill.mjs --to-repo    local -> repo (publish an edit)
//   node scripts/sync-skill.mjs --to-backup  repo  -> hermes-config-backup snapshot
//
// Without a flag it behaves like --check, so a stray run cannot overwrite a side.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME = 'live-stream-overlay';
const CATEGORY = 'software-development';
const repoDir = path.join(process.cwd(), 'skills', NAME);
const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const localDir = path.join(home, 'skills', CATEGORY, NAME);

const BACKUP_REPO = 'zeroknowledge0x/hermes-config-backup';
const BACKUP_PATH = `.hermes/skills/${CATEGORY}/${NAME}`;

const args = process.argv.slice(2);
const mode = args.includes('--to-local') ? 'to-local'
  : args.includes('--to-repo') ? 'to-repo'
    : args.includes('--to-backup') ? 'to-backup'
      : 'check';

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

// One commit for the whole skill via the Git trees API, so adding a file never means
// cloning the 180 MB backup repository.
//
// This talks HTTPS directly: on this RDP a Node/python child process cannot spawn `gh`
// (EPERM / "Access is denied"), so the CLI is unusable from here. The token comes from
// GH_TOKEN, GITHUB_TOKEN, or the gh hosts file.
function readToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  const hosts = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  if (fs.existsSync(hosts)) {
    const m = fs.readFileSync(hosts, 'utf8').match(/oauth_token:\s*(\S+)/);
    if (m) return m[1];
  }
  throw new Error('no GitHub token found - run: GH_TOKEN=$(gh auth token) node scripts/sync-skill.mjs --to-backup');
}

async function ghApi(method, apiPath, payload) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${readToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'hermes-agent',
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${method} ${apiPath}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

async function pushBackup() {
  const ref = await ghApi('GET', `/repos/${BACKUP_REPO}/git/ref/heads/main`);
  const parentSha = ref.object.sha;
  const parent = await ghApi('GET', `/repos/${BACKUP_REPO}/git/commits/${parentSha}`);
  const tree = [];
  for (const rel of walk(repoDir)) {
    const raw = fs.readFileSync(path.join(repoDir, rel));
    const blob = await ghApi('POST', `/repos/${BACKUP_REPO}/git/blobs`, { content: raw.toString('base64'), encoding: 'base64' });
    tree.push({ path: `${BACKUP_PATH}/${rel}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await ghApi('POST', `/repos/${BACKUP_REPO}/git/trees`, { base_tree: parent.tree.sha, tree });
  if (newTree.sha === parent.tree.sha) {
    console.log('backup already matches - nothing to push');
    return;
  }
  const commit = await ghApi('POST', `/repos/${BACKUP_REPO}/git/commits`, {
    message: ['feat(skills): sync ' + NAME + ' (' + tree.length + ' files)', '', 'Mirrored from Hubie-Live.'].join(String.fromCharCode(10)),
    tree: newTree.sha,
    parents: [parentSha],
  });
  await ghApi('PATCH', `/repos/${BACKUP_REPO}/git/refs/heads/main`, { sha: commit.sha });
  console.log(`pushed ${commit.sha.slice(0, 7)} to ${BACKUP_REPO}`);
}

if (mode === 'to-backup') {
  try { await pushBackup(); } catch (err) { console.error(err.message); process.exit(1); }
  process.exit(0);
}

const repoFiles = walk(repoDir);
const localFiles = walk(localDir);
const all = [...new Set([...repoFiles, ...localFiles])].sort();

const diffs = [];
for (const rel of all) {
  const a = path.join(repoDir, rel);
  const b = path.join(localDir, rel);
  if (!fs.existsSync(a)) { diffs.push(`only local: ${rel}`); continue; }
  if (!fs.existsSync(b)) { diffs.push(`only repo:  ${rel}`); continue; }
  if (fs.readFileSync(a, 'utf8') !== fs.readFileSync(b, 'utf8')) diffs.push(`different:  ${rel}`);
}

console.log(`repo  ${repoDir}`);
console.log(`local ${localDir}`);
if (!diffs.length) {
  console.log('\nsynced - both copies are identical');
  process.exit(0);
}
console.log(`\n${diffs.length} difference(s):`);
for (const d of diffs) console.log(`  ${d}`);

if (mode === 'check') {
  console.log('\nnothing written. use --to-local or --to-repo');
  process.exit(1);
}

const from = mode === 'to-local' ? repoDir : localDir;
const to = mode === 'to-local' ? localDir : repoDir;
if (!fs.existsSync(from)) {
  console.error(`\nsource missing: ${from}`);
  process.exit(1);
}
fs.mkdirSync(to, { recursive: true });
for (const rel of walk(from)) {
  const dest = path.join(to, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(from, rel), dest);
  console.log(`  ${mode === 'to-local' ? '->' : '<-'} ${rel}`);
}
console.log(`\n${mode === 'to-local' ? 'installed to Hermes' : 'published to repo'}`);
