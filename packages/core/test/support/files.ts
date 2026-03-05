import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

export function writeTextFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}
