import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommandChain, runChain } from "../src/tools/shell-chain.js";
import { runCommand } from "../src/tools/shell.js";

describe("parseCommandChain — redirects", () => {
  it("parses `>` truncate", () => {
    const c = parseCommandChain("echo hi > out.txt");
    expect(c).not.toBeNull();
    expect(c!.segments[0]!.argv).toEqual(["echo", "hi"]);
    expect(c!.segments[0]!.redirects).toEqual([{ kind: ">", target: "out.txt" }]);
  });

  it("parses `>>` append", () => {
    const c = parseCommandChain("echo hi >> log.txt");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: ">>", target: "log.txt" }]);
  });

  it("parses `<` stdin", () => {
    const c = parseCommandChain("sort < data.txt");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "<", target: "data.txt" }]);
  });

  it("parses `2>` stderr to file", () => {
    const c = parseCommandChain("cmd 2> err.log");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "2>", target: "err.log" }]);
  });

  it("parses `2>>` stderr append", () => {
    const c = parseCommandChain("cmd 2>> err.log");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "2>>", target: "err.log" }]);
  });

  it("parses `2>&1` merge stderr to stdout", () => {
    const c = parseCommandChain("cmd 2>&1");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "2>&1", target: "" }]);
  });

  it("parses `&>` both to file", () => {
    const c = parseCommandChain("cmd &> all.log");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "&>", target: "all.log" }]);
  });

  it("parses redirects stuck to the target (`>file`)", () => {
    const c = parseCommandChain("echo hi >out.txt");
    expect(c!.segments[0]!.redirects).toEqual([{ kind: ">", target: "out.txt" }]);
  });

  it("parses `cmd > file 2>&1` (stdout to file, stderr merged)", () => {
    const c = parseCommandChain("cmd > all.log 2>&1");
    expect(c!.segments[0]!.redirects).toEqual([
      { kind: ">", target: "all.log" },
      { kind: "2>&1", target: "" },
    ]);
  });

  it("parses redirects on a piped chain segment", () => {
    const c = parseCommandChain("cat < data.txt | grep foo > out.txt");
    expect(c!.segments).toHaveLength(2);
    expect(c!.segments[0]!.argv).toEqual(["cat"]);
    expect(c!.segments[0]!.redirects).toEqual([{ kind: "<", target: "data.txt" }]);
    expect(c!.segments[1]!.argv).toEqual(["grep", "foo"]);
    expect(c!.segments[1]!.redirects).toEqual([{ kind: ">", target: "out.txt" }]);
  });

  it("preserves quoted target with spaces", () => {
    const c = parseCommandChain('echo hi > "out file.txt"');
    expect(c!.segments[0]!.redirects).toEqual([{ kind: ">", target: "out file.txt" }]);
  });

  it("rejects redirect missing its target", () => {
    expect(() => parseCommandChain("echo hi >")).toThrow(/redirect ">" is missing a target/);
    expect(() => parseCommandChain("sort <")).toThrow(/redirect "<" is missing/);
  });

  it("rejects two redirects with no target between them", () => {
    expect(() => parseCommandChain("cmd > > out")).toThrow(/missing a target/);
  });

  it("rejects multiple stdout redirects in one segment", () => {
    expect(() => parseCommandChain("cmd > a > b")).toThrow(/multiple stdout redirects/);
    expect(() => parseCommandChain("cmd > a &> b")).toThrow(/multiple stdout/);
  });

  it("rejects multiple stderr redirects in one segment", () => {
    expect(() => parseCommandChain("cmd 2> a 2> b")).toThrow(/multiple stderr redirects/);
    expect(() => parseCommandChain("cmd 2>&1 2> b")).toThrow(/multiple stderr/);
  });

  it("rejects redirect without a command", () => {
    expect(() => parseCommandChain("> out.txt")).toThrow(/redirect without a command/);
  });

  it("rejects heredoc `<<`", () => {
    expect(() => parseCommandChain("cat << EOF")).toThrow(/"<<".*not supported/);
  });

  it("rejects standalone background `&`", () => {
    expect(() => parseCommandChain("cmd &")).toThrow(/"&" is not supported/);
  });

  it("treats `&` inside a token as literal (lenient)", () => {
    const c = parseCommandChain("cargo run -- --flag=1&2");
    expect(c).toBeNull();
  });
});

describe("runChain — redirect execution", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-redir-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseOpts = { timeoutSec: 10, maxOutputChars: 32_000 };

  it("`>` writes stdout to a file (truncate)", async () => {
    writeFileSync(join(tmp, "out.txt"), "stale content\n");
    const c = parseCommandChain("node -e \"process.stdout.write('hello')\" > out.txt")!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(tmp, "out.txt"), "utf8")).toBe("hello");
  });

  it("`>>` appends stdout to an existing file", async () => {
    writeFileSync(join(tmp, "log.txt"), "first\n");
    const c = parseCommandChain("node -e \"process.stdout.write('second')\" >> log.txt")!;
    await runChain(c, { cwd: tmp, ...baseOpts });
    expect(readFileSync(join(tmp, "log.txt"), "utf8")).toBe("first\nsecond");
  });

  it("`<` reads stdin from a file", async () => {
    writeFileSync(join(tmp, "in.txt"), "PAYLOAD");
    const c = parseCommandChain(
      "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))\" < in.txt",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("PAYLOAD");
  });

  it("`2>` writes stderr to a file (separating from stdout)", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('err-line'); process.stdout.write('out-line')\" 2> err.log",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("out-line");
    expect(r.output).not.toContain("err-line");
    expect(readFileSync(join(tmp, "err.log"), "utf8")).toContain("err-line");
  });

  it("`2>&1` keeps stderr in the captured output (default no-op for last seg)", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('warn'); process.stdout.write('hi')\" 2>&1",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.output).toContain("hi");
    expect(r.output).toContain("warn");
  });

  it("`> file 2>&1` merges stderr into the file with stdout", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('err-line'); process.stdout.write('out-line')\" > all.log 2>&1",
    )!;
    await runChain(c, { cwd: tmp, ...baseOpts });
    const contents = readFileSync(join(tmp, "all.log"), "utf8");
    expect(contents).toContain("out-line");
    expect(contents).toContain("err-line");
  });

  it("`&>` writes both stdout and stderr to the same file", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('err-line'); process.stdout.write('out-line')\" &> all.log",
    )!;
    await runChain(c, { cwd: tmp, ...baseOpts });
    const contents = readFileSync(join(tmp, "all.log"), "utf8");
    expect(contents).toContain("out-line");
    expect(contents).toContain("err-line");
  });

  it("`cmd1 2>&1 | cmd2` merges stderr into the pipe to cmd2", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('err'); process.stdout.write('out')\" 2>&1 | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('GOT['+d+']'))\"",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("GOT[");
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
  });

  it("redirects work across pipe boundaries (`<` on first, `>` on last)", async () => {
    writeFileSync(join(tmp, "data.txt"), "alpha\nbeta\n");
    const c = parseCommandChain(
      "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))\" < data.txt > upper.txt",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(tmp, "upper.txt"), "utf8")).toContain("ALPHA");
    expect(readFileSync(join(tmp, "upper.txt"), "utf8")).toContain("BETA");
  });

  it("redirect target is resolved relative to the chain's cwd, not the test's", async () => {
    const c = parseCommandChain("node -e \"process.stdout.write('hello')\" > out.txt")!;
    await runChain(c, { cwd: tmp, ...baseOpts });
    expect(readFileSync(join(tmp, "out.txt"), "utf8")).toBe("hello");
  });

  it("rejects absolute redirect targets outside the sandbox", async () => {
    const outside = `${tmp}-outside.txt`;
    rmSync(outside, { force: true });
    try {
      const c = parseCommandChain(`node -e "process.stdout.write('blocked')" > "${outside}"`)!;
      await expect(runChain(c, { cwd: tmp, ...baseOpts })).rejects.toThrow(
        /outside the workspace sandbox/,
      );
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("rejects relative redirect targets that escape the sandbox", async () => {
    const outside = join(tmp, "..", "reasonix-redir-outside.txt");
    rmSync(outside, { force: true });
    try {
      const c = parseCommandChain(
        "node -e \"process.stdout.write('blocked')\" > ../reasonix-redir-outside.txt",
      )!;
      await expect(runChain(c, { cwd: tmp, ...baseOpts })).rejects.toThrow(
        /outside the workspace sandbox/,
      );
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("allows absolute redirect targets inside the sandbox", async () => {
    const inside = join(tmp, "inside-absolute.txt");
    const c = parseCommandChain(`node -e "process.stdout.write('inside')" > "${inside}"`)!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(inside, "utf8")).toBe("inside");
  });

  it("rejects output redirects through a symlinked directory to an outside file", async () => {
    const outsideDir = `${tmp}-output-outside-dir`;
    const linkDir = join(tmp, "output-link");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, linkDir, "junction");
    try {
      const c = parseCommandChain(
        "node -e \"process.stdout.write('blocked')\" > output-link/out.txt",
      )!;
      await expect(runChain(c, { cwd: tmp, ...baseOpts })).rejects.toThrow(
        /outside the workspace sandbox/,
      );
      expect(existsSync(join(outsideDir, "out.txt"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects input redirects through a symlinked directory to an outside file", async () => {
    const outsideDir = `${tmp}-input-outside-dir`;
    const linkDir = join(tmp, "input-link");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "SECRET");
    symlinkSync(outsideDir, linkDir, "junction");
    try {
      const c = parseCommandChain(
        "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))\" < input-link/secret.txt",
      )!;
      await expect(runChain(c, { cwd: tmp, ...baseOpts })).rejects.toThrow(
        /outside the workspace sandbox/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects writes under a symlinked directory that points outside the sandbox", async () => {
    const outsideDir = `${tmp}-outside-dir`;
    const linkDir = join(tmp, "linked-dir");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, linkDir, "junction");
    try {
      const c = parseCommandChain(
        "node -e \"process.stdout.write('blocked')\" > linked-dir/out.txt",
      )!;
      await expect(runChain(c, { cwd: tmp, ...baseOpts })).rejects.toThrow(
        /outside the workspace sandbox/,
      );
      expect(existsSync(join(outsideDir, "out.txt"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("runCommand — redirect dispatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-redir-rc-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs `echo > file` through the public runCommand API", async () => {
    const r = await runCommand(
      "node -e \"process.stdout.write('via-runcommand')\" > captured.txt",
      {
        cwd: tmp,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(tmp, "captured.txt"), "utf8")).toBe("via-runcommand");
  });

  it("propagates the exit code of the redirected command", async () => {
    const r = await runCommand('node -e "process.exit(7)" > out.txt', { cwd: tmp });
    expect(r.exitCode).toBe(7);
  });
});

describe("runChain — null-device redirects", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-null-dev-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseOpts = { timeoutSec: 10, maxOutputChars: 32_000 };

  it("`2> /dev/null` discards stderr without creating a `/dev/null` file in cwd", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('noisy'); process.stdout.write('quiet')\" 2> /dev/null",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("quiet");
    expect(r.output).not.toContain("noisy");
    expect(existsSync(join(tmp, "dev"))).toBe(false);
    expect(existsSync(join(tmp, "/dev/null"))).toBe(false);
  });

  it("`> /dev/null` discards stdout without creating a file in cwd", async () => {
    const c = parseCommandChain("node -e \"process.stdout.write('vanish')\" > /dev/null")!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("vanish");
    expect(existsSync(join(tmp, "dev"))).toBe(false);
  });

  it("`2>nul` follows the host null-device semantics", async () => {
    const c = parseCommandChain(
      "node -e \"console.error('boom'); process.stdout.write('ok')\" 2>nul",
    )!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok");
    expect(r.output).not.toContain("boom");
    if (process.platform === "win32") {
      expect(existsSync(join(tmp, "nul"))).toBe(false);
    } else {
      expect(existsSync(join(tmp, "nul"))).toBe(true);
    }
  });

  it("uppercase `2>NUL` follows the host null-device semantics", async () => {
    const c = parseCommandChain("node -e \"console.error('x')\" 2>NUL")!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    if (process.platform === "win32") {
      expect(existsSync(join(tmp, "NUL"))).toBe(false);
      expect(existsSync(join(tmp, "nul"))).toBe(false);
    } else {
      expect(existsSync(join(tmp, "NUL"))).toBe(true);
      expect(readFileSync(join(tmp, "NUL"), "utf8")).toBe("x\n");
    }
  });

  it("`nul` follows the host null-device semantics for stdout", async () => {
    const c = parseCommandChain("node -e \"process.stdout.write('p')\" > nul")!;
    const r = await runChain(c, { cwd: tmp, ...baseOpts });
    expect(r.exitCode).toBe(0);
    if (process.platform === "win32") {
      expect(r.output).not.toContain("p");
      expect(existsSync(join(tmp, "nul"))).toBe(false);
    } else {
      expect(existsSync(join(tmp, "nul"))).toBe(true);
      expect(readFileSync(join(tmp, "nul"), "utf8")).toBe("p");
    }
  });
});
