import type { OutputFilterResult } from "../output-filter.js";

export function filterGitStatus(raw: string): OutputFilterResult {
  const clean = raw.trim();
  if (!clean)
    return { commandFamily: "git-status", mode: "passthrough", output: raw, omitted: false };
  if (/^(?:##|[ MADRCU?!]{2}\s)/m.test(clean)) {
    return { commandFamily: "git-status", mode: "passthrough", output: raw, omitted: false };
  }
  const branch = clean.match(/^On branch (.+)$/m)?.[1];
  const groups: Array<[string, RegExp]> = [
    ["staged", /^Changes to be committed:/m],
    ["unstaged", /^Changes not staged for commit:/m],
    ["untracked", /^Untracked files:/m],
    ["conflicts", /^Unmerged paths:/m],
  ];
  const lines: string[] = [branch ? `branch ${branch}` : "git status"];
  for (const [name, heading] of groups) {
    if (heading.test(clean)) lines.push(name);
  }
  const inProgress = clean.match(
    /^(?:You are currently|All conflicts fixed but you are still|interactive rebase in progress).+$/m,
  );
  if (inProgress) lines.push(inProgress[0]);
  if (lines.length === 1) {
    if (/nothing to commit, working tree clean/i.test(clean)) lines.push("clean");
    else {
      return {
        commandFamily: "git-status",
        mode: "degraded",
        output: raw,
        warning: "git status shape not recognized; raw output preserved",
        omitted: false,
      };
    }
  }
  const output = lines.join("\n");
  if (output.length >= clean.length) {
    return { commandFamily: "git-status", mode: "passthrough", output: raw, omitted: false };
  }
  return { commandFamily: "git-status", mode: "filtered", output, omitted: true };
}
