import { describe, expect, it } from "vitest";
import { compactDescription, pruneMcpToolSchema } from "../src/mcp/schema-prune.js";
import type { JSONSchema } from "../src/types.js";

describe("MCP schema pruning and compression", () => {
  describe("compactDescription", () => {
    it("preserves short descriptions without modification", () => {
      expect(compactDescription("A concise tool description.")).toBe("A concise tool description.");
    });

    it("truncates multi-sentence descriptions to the first complete sentence", () => {
      const longDesc =
        "Creates a new mail message draft. This draft can be updated multiple times before sending. See Microsoft Graph documentation for details.";
      expect(compactDescription(longDesc, 80)).toBe("Creates a new mail message draft.");
    });

    it("clamps long single sentences with ellipsis", () => {
      const longSentence =
        "This is an extremely long single sentence description without any punctuation that goes on and on and explains every tiny detail of the field.";
      const compacted = compactDescription(longSentence, 50);
      expect(compacted.length).toBeLessThanOrEqual(50);
      expect(compacted.endsWith("...")).toBe(true);
    });
  });

  describe("pruneMcpToolSchema", () => {
    it("strips readOnly: true properties unless they are required", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          id: { type: "string", readOnly: true },
          name: { type: "string" },
          code: { type: "string", readOnly: true },
        },
        required: ["code"],
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.id).toBeUndefined();
      expect(pruned.properties?.name).toBeDefined();
      expect(pruned.properties?.code).toBeDefined();
      expect(pruned.required).toEqual(["code"]);
    });

    it("strips properties described as Read-only", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The unique identifier for an entity. Read-only.",
          },
          subject: { type: "string", description: "Subject of the email." },
        },
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.id).toBeUndefined();
      expect(pruned.properties?.subject).toBeDefined();
    });

    it("strips metadata property bags like ExtendedProperties and internetMessageHeaders", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          subject: { type: "string" },
          singleValueExtendedProperties: { type: "array", items: {} },
          multiValueExtendedProperties: { type: "array", items: {} },
          internetMessageHeaders: { type: "array", items: {} },
        },
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.subject).toBeDefined();
      expect(pruned.properties?.singleValueExtendedProperties).toBeUndefined();
      expect(pruned.properties?.multiValueExtendedProperties).toBeUndefined();
      expect(pruned.properties?.internetMessageHeaders).toBeUndefined();
    });

    it("strips non-required entity child collections", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          displayName: { type: "string" },
          messages: { type: "array", items: { type: "object" } },
          messageRules: { type: "array", items: { type: "object" } },
          childFolders: { type: "array", items: { type: "object" } },
        },
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.displayName).toBeDefined();
      expect(pruned.properties?.messages).toBeUndefined();
      expect(pruned.properties?.messageRules).toBeUndefined();
      expect(pruned.properties?.childFolders).toBeUndefined();
    });

    it("preserves child collections if they are explicitly marked as required", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          messages: { type: "array", items: { type: "object" } },
        },
        required: ["messages"],
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.messages).toBeDefined();
    });

    it("removes empty object stubs", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          subject: { type: "string" },
          dueDateTime: {},
          from: {},
        },
      };

      const pruned = pruneMcpToolSchema(schema);
      expect(pruned.properties?.subject).toBeDefined();
      expect(pruned.properties?.dueDateTime).toBeUndefined();
      expect(pruned.properties?.from).toBeUndefined();
    });

    it("recursively prunes nested object schemas and array items", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          message: {
            type: "object",
            properties: {
              subject: { type: "string" },
              id: { type: "string", readOnly: true },
              recipients: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    changeKey: {
                      type: "string",
                      description: "Identifies version. Read-only.",
                    },
                  },
                },
              },
            },
          },
        },
      };

      const pruned = pruneMcpToolSchema(schema);
      const msg = pruned.properties?.message as JSONSchema;
      expect(msg.properties?.subject).toBeDefined();
      expect(msg.properties?.id).toBeUndefined();

      const recipients = msg.properties?.recipients as JSONSchema;
      const recItem = recipients.items as JSONSchema;
      expect(recItem.properties?.address).toBeDefined();
      expect(recItem.properties?.changeKey).toBeUndefined();
    });

    it("handles union keywords (oneOf, anyOf, allOf)", () => {
      const schema: JSONSchema = {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              typeA: { type: "string" },
              id: { type: "string", readOnly: true },
            },
          },
          {
            type: "object",
            properties: {
              typeB: { type: "string" },
            },
          },
        ],
      };

      const pruned = pruneMcpToolSchema(schema);
      const branches = pruned.oneOf as JSONSchema[];
      expect(branches[0]?.properties?.typeA).toBeDefined();
      expect(branches[0]?.properties?.id).toBeUndefined();
      expect(branches[1]?.properties?.typeB).toBeDefined();
    });

    it("produces deterministic output across multiple invocations", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          b: { type: "string", description: "Second property with text." },
          a: { type: "number", description: "First property. Extra documentation." },
          id: { type: "string", readOnly: true },
        },
      };

      const res1 = JSON.stringify(pruneMcpToolSchema(schema));
      const res2 = JSON.stringify(pruneMcpToolSchema(schema));
      expect(res1).toBe(res2);
    });
  });
});
