import { describe, expect, it } from "vitest";
import { repairTruncatedJson, splitConcatenatedJsonObjects } from "../../src/repair/truncation.js";

describe("repairTruncatedJson", () => {
  it("returns parseable JSON unchanged", () => {
    const r = repairTruncatedJson('{"a":1}');
    expect(r.changed).toBe(false);
    expect(r.repaired).toBe('{"a":1}');
  });

  it("closes unbalanced braces", () => {
    const r = repairTruncatedJson('{"a":1');
    expect(r.changed).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes nested unbalanced structures", () => {
    const r = repairTruncatedJson('{"a":{"b":[1,2');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("closes unterminated string", () => {
    const r = repairTruncatedJson('{"a":"he');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired).a.startsWith("he")).toBe(true);
  });

  it("fills dangling key with null", () => {
    const r = repairTruncatedJson('{"a":');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: null });
  });

  it("handles empty input", () => {
    const r = repairTruncatedJson("");
    expect(r.repaired).toBe("{}");
  });

  it("drops trailing comma", () => {
    const r = repairTruncatedJson('{"a":1,');
    expect(() => JSON.parse(r.repaired)).not.toThrow();
    expect(JSON.parse(r.repaired)).toEqual({ a: 1 });
  });

  it("trims trailing garbage after a complete JSON object", () => {
    const r = repairTruncatedJson('{"a":1}oops');
    expect(r.changed).toBe(true);
    expect(r.repaired).toBe('{"a":1}');
    expect(r.fallback).toBe(false);
    expect(r.notes.join("\n")).toContain("trailing content");
  });

  it("salvages the leading object from provider-concatenated emission", () => {
    const r = repairTruncatedJson('{"task":"dsh"}{"task":"reasonix"}');
    expect(r.changed).toBe(true);
    expect(r.repaired).toBe('{"task":"dsh"}');
    expect(r.fallback).toBe(false);
  });

  it("scanner is string-aware: braces inside strings do not end the object", () => {
    const r = repairTruncatedJson('{"a":"x { y } z"}trailing');
    expect(r.repaired).toBe('{"a":"x { y } z"}');
  });

  it("leaves parseable input unchanged (no salvage needed)", () => {
    const r = repairTruncatedJson('{"a":1}');
    expect(r.changed).toBe(false);
    expect(r.repaired).toBe('{"a":1}');
  });
});

describe("splitConcatenatedJsonObjects", () => {
  it("returns null for a single complete object", () => {
    expect(splitConcatenatedJsonObjects('{"task":"x"}')).toBeNull();
  });

  it("returns null for truncated or empty input", () => {
    expect(splitConcatenatedJsonObjects('{"task":"x"')).toBeNull();
    expect(splitConcatenatedJsonObjects("")).toBeNull();
  });

  it("splits across junk between objects — the scanner only sees {...} substrings", () => {
    // Junk between the objects is artifact noise; both objects are intact calls.
    const r = splitConcatenatedJsonObjects('{"a":1}42{"b":2}');
    expect(r).not.toBeNull();
    expect(r!.parts).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("splits two concatenated objects in order", () => {
    const r = splitConcatenatedJsonObjects('{"task":"a"}{"task":"b"}');
    expect(r).not.toBeNull();
    expect(r!.parts).toEqual(['{"task":"a"}', '{"task":"b"}']);
    expect(r!.droppedObjects).toBe(0);
  });

  it("handles strings containing braces and whitespace between objects", () => {
    const r = splitConcatenatedJsonObjects('{"a":"x { y } z"}  {"b":"}{"}');
    expect(r).not.toBeNull();
    expect(r!.parts).toEqual(['{"a":"x { y } z"}', '{"b":"}{"}']);
  });

  it("caps kept objects and reports the overflow loudly", () => {
    const many = Array.from({ length: 10 }, (_, i) => `{"i":${i}}`).join("");
    const r = splitConcatenatedJsonObjects(many, 8);
    expect(r).not.toBeNull();
    expect(r!.parts).toHaveLength(8);
    expect(r!.droppedObjects).toBe(2);
  });
});
