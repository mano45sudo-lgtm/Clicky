const fs = require('fs');
const path = require('path');

// Desktop-native-ish integrations, file-based so they run anywhere without OS
// APIs: a Notes notebook and a Reminders list stored under userData, plus safe
// folder helpers used by the agent (list / summarize / tidy).
let dir = null;

function init(userDataDir) {
  dir = path.join(userDataDir, 'clicky-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true }); } catch (e) {}
}

function notesFile() {
  return path.join(dir, 'Notes');
}

// --- Notes ---
function listNotes() {
  try {
    return fs
      .readdirSync(notesFile())
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f.replace(/\.md$/, ''), at: fs.statSync(path.join(notesFile(), f)).mtimeMs }));
  } catch (e) {
    return [];
  }
}

function writeNote(name, content) {
  const safe = String(name || 'note').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'note';
  const file = path.join(notesFile(), `${safe}.md`);
  fs.writeFileSync(file, `# ${safe}\n\n${content}\n`, 'utf8');
  return { name: safe, file };
}

function readNote(name) {
  const file = path.join(notesFile(), `${name}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

// --- Reminders ---
function remindersFile() {
  return path.join(dir, 'reminders.json');
}

function readReminders() {
  try {
    return JSON.parse(fs.readFileSync(remindersFile(), 'utf8'));
  } catch (e) {
    return [];
  }
}

function addReminder(text, due) {
  const arr = readReminders();
  const item = { id: arr.length + 1, text, due: due || null, done: false, at: Date.now() };
  arr.push(item);
  fs.writeFileSync(remindersFile(), JSON.stringify(arr, null, 2), 'utf8');
  return item;
}

function completeReminder(id) {
  const arr = readReminders();
  const it = arr.find((x) => x.id === Number(id));
  if (it) it.done = true;
  fs.writeFileSync(remindersFile(), JSON.stringify(arr, null, 2), 'utf8');
  return it;
}

// --- Folder helpers (used by the agent) ---
function listDir(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .map((d) => ({ name: d.name, dir: d.isDirectory() }));
  } catch (e) {
    return { error: e.message };
  }
}

// Group files by extension - a safe "cleanup" preview (does not move/delete).
function folderSummary(dirPath) {
  const entries = listDir(dirPath);
  if (Array.isArray(entries) === false) return entries;
  const byExt = {};
  let total = 0;
  for (const e of entries) {
    if (e.dir) continue;
    total += 1;
    const ext = (e.name.split('.').pop() || 'no-ext').toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  return { path: dirPath, fileCount: total, byExtension: byExt };
}

module.exports = {
  init,
  listNotes,
  writeNote,
  readNote,
  addReminder,
  completeReminder,
  readReminders,
  listDir,
  folderSummary
};
