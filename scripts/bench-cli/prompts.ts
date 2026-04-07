import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { MenuChoice } from "./types";

const rl = createInterface({ input, output });

export async function ask(prompt: string): Promise<string> {
  const answer = await rl.question(`${prompt} `);
  return answer.trim();
}

export async function choose(choices: MenuChoice[]): Promise<MenuChoice | "back" | "quit"> {
  const answer = (await ask("Select"))
    .trim()
    .toLowerCase();

  if (answer === "q" || answer === "quit" || answer === "exit") {
    return "quit";
  }
  if (answer === "b" || answer === "back") {
    return "back";
  }

  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1];
  }

  return "back";
}

export function closePrompts() {
  rl.close();
}
