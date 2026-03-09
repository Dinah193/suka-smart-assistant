const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const tracked = new Set(
  cp
    .execSync('git ls-files "src/features/calculators/**"', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
);

const root = path.join('src', 'pages', 'calculators');
const changes = [];

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const replaced = original.replace(/@\/features\/calculators\/([^"']+?)\.view\.jsx/g, (full, subPath) => {
    const flat = `src/features/calculators/${subPath}.view.jsx`;
    if (tracked.has(flat)) return full;

    const name = subPath.split('/').pop();
    const nested = `src/features/calculators/${subPath}/${name}.view.jsx`;
    if (tracked.has(nested)) {
      const target = `@/features/calculators/${subPath}/${name}.view.jsx`;
      changes.push({ filePath, from: full, to: target });
      return target;
    }

    return full;
  });

  if (replaced !== original) {
    fs.writeFileSync(filePath, replaced);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
    } else if (entry.isFile() && abs.endsWith('.jsx')) {
      processFile(abs);
    }
  }
}

walk(root);

console.log(`AUTOFIX_COUNT:${changes.length}`);
for (const change of changes) {
  console.log(`${change.filePath} :: ${change.from} -> ${change.to}`);
}
