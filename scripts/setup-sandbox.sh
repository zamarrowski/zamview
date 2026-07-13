#!/usr/bin/env bash
# Recreates the demo repos used by the F5 launch configs. They are not
# committed to this repo because they contain nested git repos of their own.
set -euo pipefail
cd "${1:-$(dirname "$0")/..}"

rm -rf sandbox sandbox2

mkdir sandbox && cd sandbox
git init -q
cat > app.js <<'EOF'
function add(a, b) {
  return a + b;
}

module.exports = { add };
EOF
printf 'node_modules/\n' > .gitignore
git add -A
git -c user.name="ZamView Sandbox" -c user.email="sandbox@zamview.local" commit -qm "initial state"
# Simulated AI changes: one modified file, one new file
cat > app.js <<'EOF'
function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, divide };
EOF
cat > utils.js <<'EOF'
function formatResult(value) {
  return `Result: ${value}`;
}

module.exports = { formatResult };
EOF
cd ..

mkdir sandbox2 && cd sandbox2
git init -q
cat > api.js <<'EOF'
function fetchUser(id) {
  return fetch(`/api/users/${id}`).then((res) => res.json());
}

module.exports = { fetchUser };
EOF
printf 'node_modules/\n' > .gitignore
git add -A
git -c user.name="ZamView Sandbox" -c user.email="sandbox@zamview.local" commit -qm "initial state"
cat > api.js <<'EOF'
function fetchUser(id) {
  return fetch(`/api/users/${id}`).then((res) => res.json());
}

function deleteUser(id) {
  return fetch(`/api/users/${id}`, { method: 'DELETE' });
}

module.exports = { fetchUser, deleteUser };
EOF
cd ..

echo "Sandbox repos ready. Press F5 in VSCode to try the extension."
