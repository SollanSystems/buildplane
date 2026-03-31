const fs = require('fs');
let code = fs.readFileSync('packages/adapters-git/src/worktree-adapter.ts', 'utf8');

// Ensure that NO spawn exceptions are missed.
code = code.replace(
  `	if (result.error) {
		// e.g., git is not installed, ENONENT
		return {
			...result,
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr:
				result.stderr ?? \`Failed to launch git command: \${result.error.message}\`,
		};
	}`,
  `	if (result.error) {
		// e.g., git is not installed, ENONENT
		return {
			...result,
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr:
				result.stderr ?? \`Failed to launch git command: \${result.error.message}\`,
		};
	}`
);

// Actually, in `test/run-cli.test.ts`, the error is thrown inside `assertRunnableRepository`.
// "fails clearly when the git binary is unavailable" is expecting the error to match `/git .* unavailable/i` exactly.
// It fails because it receives the wrapper error.
// The wrapper error is: `${projectRoot} does not appear to be inside a git repository: Failed to launch git command...`
// Our `versionCheck` code DID fix it in the unit test, BUT it probably still failed because `cli` passes a mock runner?
// Ah, `cli` tests use the REAL adapter but pass `gitBinary: "git"`.
// Wait, `test/run-cli.test.ts` uses `gitBinary: "git"`. The test is `returns stable operator-facing errors for setup failures and git preflight failures`.
// It sets up the environment with `PATH` without `git`!
// Ah. `const missingGit = runCli(root, ["run", "packet.json"], { PATH: "" });`
// In this test, it runs the `cli` as a separate node process!
// It expects the CLI stderr to say `git binary is unavailable` or similar.
// The CLI process prints the error thrown by `assertRunnableRepository`.
// Since `versionCheck` now throws `git binary is unavailable: git`, this should work?
// Let's check `test/run-cli.test.ts` to see what exact error text it expects.

