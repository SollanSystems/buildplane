const fs = require("fs");
let code = fs.readFileSync("apps/cli/src/run-cli.ts", "utf8");

code = code.replace(
	"adaptersGit.createGitWorkspaceAdapter()",
	"adaptersGit.createGitWorktreeAdapter()",
);

fs.writeFileSync("apps/cli/src/run-cli.ts", code);
