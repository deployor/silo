import { existsSync } from "node:fs";

function git(args: string[], fallback = "unknown") {
	const proc = Bun.spawnSync(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!proc.success) return fallback;
	const value = proc.stdout.toString().trim();
	return value || fallback;
}

const envFile =
	process.env.SILO_ENV_FILE ||
	(existsSync(".env.production") ? ".env.production" : ".env");
const composeArgs = Bun.argv.slice(2);
const args = composeArgs.length > 0 ? composeArgs : ["up", "-d", "--build"];

const env = {
	...process.env,
	SILO_ENV_FILE: envFile,
	GIT_SHA: process.env.GIT_SHA || git(["rev-parse", "HEAD"]),
	GIT_DATE: process.env.GIT_DATE || git(["show", "-s", "--format=%cI", "HEAD"]),
	GIT_MESSAGE:
		process.env.GIT_MESSAGE || git(["show", "-s", "--format=%s", "HEAD"]),
};

console.log(`SILO_ENV_FILE=${env.SILO_ENV_FILE}`);
console.log(`GIT_SHA=${env.GIT_SHA}`);
console.log(`GIT_DATE=${env.GIT_DATE}`);
console.log(`GIT_MESSAGE=${env.GIT_MESSAGE}`);

const proc = Bun.spawnSync(
	[
		"docker",
		"compose",
		"-f",
		"docker-compose.prod.yml",
		"--env-file",
		envFile,
		...args,
	],
	{
		env,
		stdout: "inherit",
		stderr: "inherit",
	},
);

process.exit(proc.exitCode ?? 1);
