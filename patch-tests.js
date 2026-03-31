const fs = require('fs');
const glob = require('glob');
const files = glob.sync('test/**/*.ts').concat(glob.sync('packages/**/*.test.ts')).concat(glob.sync('apps/**/*.test.ts'));

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('createGitWorkspaceAdapter')) {
    fs.writeFileSync(file, content.replace(/createGitWorkspaceAdapter/g, 'createGitWorktreeAdapter'));
  }
}
