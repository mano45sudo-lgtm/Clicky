const fs = require('fs');
const path = require('path');

// Persistent, lightweight memory for conversation turns and agent task history.
// Stored as JSON in userData. Bounded so it never grows unbounded.
let dir = null;
let loaded = null;
const LIMIT = 200;

function init(userDataDir) {
  dir = path.join(userDataDir, 'clicky-memory');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  loaded = null;
}

function file(name) {
  return path.join(dir || '.', `${name}.json`);
}

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return [];
  }
}

function push(name, entry) {
  const arr = read(name);
  arr.push({ at: Date.now(), ...entry });
  while (arr.length > LIMIT) arr.shift();
  try {
    fs.writeFileSync(file(name), JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('[memory] write failed', e.message);
  }
  return arr;
}

function addTurn(question, answer) {
  return push('conversation', { question, answer });
}

function addTask(goal, status, detail) {
  return push('tasks', { goal, status, detail });
}

function recentConversations(n = 6) {
  const arr = read('conversation');
  return arr.slice(-n);
}

function allTasks() {
  return read('tasks');
}

module.exports = { init, addTurn, addTask, recentConversations, allTasks };
