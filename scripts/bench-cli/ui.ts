import type { MenuChoice } from "./types";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const FRAMES = ["-", "\\", "|", "/"];

function interactive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export function color(text: string, code: string): string {
  return interactive() ? `${code}${text}${ANSI.reset}` : text;
}

export function banner(title: string, subtitle: string): void {
  console.clear();
  const line = "=".repeat(Math.max(40, Math.min(84, title.length + subtitle.length + 18)));
  console.log(color(line, ANSI.cyan));
  console.log(`${color("S3 Benchmark Control", ANSI.bold)} ${color("|", ANSI.gray)} ${color(title, ANSI.blue)}`);
  console.log(color(subtitle, ANSI.dim));
  console.log(color(line, ANSI.cyan));
  console.log("");
}

export function drawMenu(title: string, choices: MenuChoice[]): void {
  console.log(color(title, ANSI.bold));
  for (const [index, choice] of choices.entries()) {
    const n = color(String(index + 1).padStart(2, "0"), ANSI.yellow);
    console.log(`  ${n}  ${choice.label}`);
    console.log(`      ${color(choice.detail, ANSI.dim)}`);
  }
  console.log("");
}

export function printSection(title: string): void {
  console.log("");
  console.log(color(title, ANSI.magenta));
}

export function printKeyHint(): void {
  console.log(color("Enter number then press Enter. Type b to go back. Type q to quit.", ANSI.gray));
}

export function printOk(msg: string): void {
  console.log(color(`[OK] ${msg}`, ANSI.green));
}

export function printWarn(msg: string): void {
  console.log(color(`[WARN] ${msg}`, ANSI.yellow));
}

export function printErr(msg: string): void {
  console.log(color(`[ERR] ${msg}`, ANSI.red));
}

export function printInfo(msg: string): void {
  console.log(color(`[INFO] ${msg}`, ANSI.cyan));
}

export function createSpinner(label: string) {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = Date.now();
  const prefix = interactive() ? "\r" : "";

  return {
    start() {
      if (!interactive()) {
        console.log(color(`... ${label}`, ANSI.dim));
        return;
      }
      timer = setInterval(() => {
        const glyph = FRAMES[frame % FRAMES.length];
        frame += 1;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        process.stdout.write(`${prefix}${color(glyph, ANSI.cyan)} ${label} ${color(`${elapsed}s`, ANSI.dim)}`);
      }, 90);
    },
    stop(success: boolean, doneLabel?: string) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const icon = success ? color("[OK]", ANSI.green) : color("[ERR]", ANSI.red);
      const finalLabel = doneLabel ?? label;
      if (interactive()) {
        process.stdout.write("\r");
      }
      console.log(`${icon} ${finalLabel} ${color(`${elapsed}s`, ANSI.dim)}`);
    },
  };
}
