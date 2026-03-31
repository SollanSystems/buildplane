const fs = require('fs');
let code = fs.readFileSync('test/local-run-loop/end-to-end.test.ts', 'utf8');

// Since we now merge artifacts back for successful workspaces, the file *should* exist.
code = code.replace(
  'expect(existsSync(join(root, "tmp", "out.txt"))).toBe(false);',
  'expect(existsSync(join(root, "tmp", "out.txt"))).toBe(true);'
);

fs.writeFileSync('test/local-run-loop/end-to-end.test.ts', code);
