/** Shared test scaffolding — temp dirs, skill fixtures, etc. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** Create a temp directory that is automatically cleaned up after each test.
 *  Returns a getter function so callers can access the path at runtime. */
export function useTempDir(prefix: string): () => string {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `reasonix-${prefix}-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** Create a temp homeDir + projectRoot pair — canonical test pattern. */
export function useTempHomeAndProject(): { homeDir: () => string; projectRoot: () => string } {
  let homeDir: string;
  let projectRoot: string;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "reasonix-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-proj-"));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  return { homeDir: () => homeDir, projectRoot: () => projectRoot };
}

type SkillScope = "project" | "global";

/** Write a SKILL.md file with frontmatter, creating dirs as needed.
 *  "project" scope → `<projectRoot>/.reasonix/skills/<name>/SKILL.md`
 *  "global" scope  → `<homeDir>/.reasonix/skills/<name>/SKILL.md` */
export function writeSkillFixture(
  projectRoot: string,
  homeDir: string,
  scope: SkillScope,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): string {
  const parent =
    scope === "global"
      ? join(homeDir, ".reasonix", "skills")
      : join(projectRoot, ".reasonix", "skills");
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) fmLines.push(`${k}: ${v}`);
  fmLines.push("---", "");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `${fmLines.join("\n")}${body}\n`, "utf8");
  return path;
}
