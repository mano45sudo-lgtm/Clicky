// App knowledge pack: the real UIA control names + common synonyms for the apps
// people use most. clickOnScreen/typeInto try these candidates when the user's
// (or the model's) phrasing doesn't exactly match what Windows Accessibility
// exposes, which turns "click the new file button" into a hit on "New" instead
// of a miss + slow vision fallback. It also feeds a compact hint to the planner.

// Per-app canonical controls (as they appear in the UIA Name property).
const APP_CONTROLS = {
  word: ['Blank document', 'File Tab', 'Home Tab', 'Save', 'Bold', 'Italic', 'Paste', 'Find'],
  excel: ['New', 'File Tab', 'Home Tab', 'Name Box', 'Save', 'Sum', 'Bold'],
  powerpoint: ['Blank Presentation', 'File Tab', 'Home Tab', 'New Slide', 'Title', 'Save'],
  notepad: ['Edit', 'Format', 'File', 'Save'],
  chrome: ['Address and search bar', 'New Tab', 'Reload', 'Bookmarks bar', 'Star this tab', 'Menu'],
  edge: ['Address and search bar', 'New Tab', 'Reload', 'Favorites', 'Me'],
  explorer: ['This PC', 'Quick access', 'Address bar', 'New', 'Sort', 'Details pane'],
  settings: ['System', 'Bluetooth & other devices', 'Network & internet', 'Apps', 'Search settings'],
  outlook: ['New Email', 'Send', 'To', 'Subject', 'Inbox', 'Sent Items', 'Search'],
  calc: ['Calculator', 'Clear', 'Equals'],
  terminal: ['Command Prompt', 'PowerShell', 'New tab']
};

// Phrases users say -> the control names to try, in order.
const SYNONYMS = {
  'new': ['New', 'Blank document', 'New Tab', 'New Email', 'New Presentation', 'New slide'],
  'new document': ['Blank document', 'New', 'Blank Presentation'],
  'new file': ['New', 'Blank document'],
  'new tab': ['New Tab', 'New tab'],
  'new email': ['New Email', 'New Message', 'Compose'],
  'compose': ['New Email', 'Compose', 'New Message'],
  'save': ['Save', 'Save All'],
  'send': ['Send', 'Send button'],
  'address bar': ['Address and search bar', 'Address', 'Type text here', 'Search'],
  'url bar': ['Address and search bar', 'Address'],
  'search box': ['Search', 'Search settings', 'Find', 'Address and search bar'],
  'search': ['Search', 'Find', 'Search settings'],
  'menu': ['Menu', 'File Tab', 'File', 'Home Tab', 'See more'],
  'file menu': ['File Tab', 'File', 'File menu'],
  'home': ['Home Tab', 'Home'],
  'bold': ['Bold'],
  'italic': ['Italic'],
  'body': ['Body', 'Message body', 'Edit', 'Document', 'Type text here'],
  'subject': ['Subject', 'Subject field'],
  'to': ['To', 'To field', 'Recipients'],
  'this pc': ['This PC', 'Computer'],
  'name box': ['Name Box', 'Names Box', 'Formula Bar'],
  'formula bar': ['Formula Bar', 'Name Box'],
  'cell': ['Name Box'],
  'recycle bin': ['Recycle Bin']
};

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Whole-word phrase test, so "to" does not match inside "button".
function hasPhrase(hay, needle) {
  const esc = String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|[^a-z0-9])' + esc + '(?:$|[^a-z0-9])').test(hay);
}

// Given a free-text target, return an ordered, de-duplicated list of UIA names
// to try. Always keeps the user's original string first.
function candidateNames(target) {
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(n); };
  const raw = String(target || '').trim();
  if (!raw) return out;
  add(raw);
  const key = norm(raw);
  if (SYNONYMS[key]) SYNONYMS[key].forEach(add);
  // Match a synonym phrase only when it appears as whole words in the request.
  for (const syn of Object.keys(SYNONYMS)) {
    if (syn !== key && hasPhrase(key, syn)) SYNONYMS[syn].forEach(add);
  }
  return out;
}

// A compact "known controls" blurb to append to the agent planner system prompt,
// so the model emits names that actually exist in these apps.
function plannerHint() {
  const pick = ['word', 'excel', 'chrome', 'explorer', 'settings', 'outlook'];
  const lines = pick.map((a) => `${a}: ${APP_CONTROLS[a].slice(0, 6).join(', ')}`);
  return ' KNOWN CONTROLS (use these exact names with clickOnScreen/typeInto): ' + lines.join(' | ') +
    '. EXCEL CELLS: jump with the Name Box (clickOnScreen "Name Box" -> typeText "B2" -> pressKey "{Enter}"), then typeText the value and pressKey "{Enter}" (down) or "{Tab}" (right). Act in the open workbook, never a side file.';
}

module.exports = { APP_CONTROLS, SYNONYMS, candidateNames, plannerHint };
