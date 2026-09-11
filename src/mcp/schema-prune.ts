/** Prune and compress MCP tool schemas for model consumption. */

import type { JSONSchema } from "../types.js";

export interface SchemaPruneOptions {
  /** Maximum length for property descriptions. Defaults to 160 characters. */
  maxDescriptionLength?: number;
  /** Strip non-required fields marked read-only or described as read-only. Default true. */
  stripReadOnly?: boolean;
  /** Strip internal metadata bags like extended properties and headers. Default true. */
  stripMetadataBags?: boolean;
  /** Strip empty object stubs with zero schema constraints. Default true. */
  stripEmptyObjects?: boolean;
  /** Maximum nesting depth for schema traversal. Default 6. */
  maxDepth?: number;
}

const DEFAULT_MAX_DESCRIPTION_LENGTH = 160;
const DEFAULT_MAX_DEPTH = 6;

const METADATA_BAG_PATTERN = /(?:ExtendedProperties|internetMessageHeaders)$/i;

const CHILD_COLLECTION_NAMES = new Set(["messageRules", "messages", "childFolders"]);

/** Truncate a description to a concise first sentence or length cap. */
export function compactDescription(desc: string, maxLen = DEFAULT_MAX_DESCRIPTION_LENGTH): string {
  const trimmed = desc.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Prefer first sentence if it ends early enough.
  const match = trimmed.match(/^([^.!?\n]+[.!?])(?:\s|\n|$)/);
  if (match?.[1] && match[1].length <= maxLen) {
    return match[1].trim();
  }

  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

function isPlainEmptyObject(val: unknown): boolean {
  return (
    typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length === 0
  );
}

function isReadOnlyProperty(prop: JSONSchema): boolean {
  if (prop.readOnly === true) return true;
  if (typeof prop.description === "string" && /\bRead-only\b/i.test(prop.description)) {
    return true;
  }
  return false;
}

/** Recursively prune and compress a JSON Schema for model consumption. */
export function pruneMcpToolSchema(
  schema: JSONSchema | undefined,
  opts: SchemaPruneOptions = {},
  depth = 0,
): JSONSchema {
  if (!schema || typeof schema !== "object") {
    return (schema ?? {}) as JSONSchema;
  }

  const maxLen = opts.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const stripReadOnly = opts.stripReadOnly !== false;
  const stripMetadataBags = opts.stripMetadataBags !== false;
  const stripEmptyObjects = opts.stripEmptyObjects !== false;

  if (depth > maxDepth) {
    return schema;
  }

  const out: Record<string, unknown> = {};
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);

  for (const [key, val] of Object.entries(schema)) {
    // 1. Prune properties map
    if (key === "properties" && val && typeof val === "object" && !Array.isArray(val)) {
      const cleanProps: Record<string, JSONSchema> = {};
      const requiredArr = Array.isArray(schema.required) ? [...schema.required] : [];

      for (const [propName, propVal] of Object.entries(val as Record<string, JSONSchema>)) {
        if (!propVal || typeof propVal !== "object") continue;

        const isRequired = requiredSet.has(propName);

        // Never prune required properties.
        if (!isRequired) {
          // Strip empty stubs like `body.from: {}`
          if (stripEmptyObjects && isPlainEmptyObject(propVal)) {
            continue;
          }

          // Strip read-only properties
          if (stripReadOnly && isReadOnlyProperty(propVal)) {
            continue;
          }

          // Strip metadata bags like extended properties and headers
          if (stripMetadataBags && METADATA_BAG_PATTERN.test(propName)) {
            continue;
          }

          // Strip non-required heavy child collections on entities
          const basePropName = propName.split(".").pop() ?? propName;
          if (CHILD_COLLECTION_NAMES.has(basePropName)) {
            continue;
          }
        }

        cleanProps[propName] = pruneMcpToolSchema(propVal, opts, depth + 1);
      }

      out.properties = cleanProps;

      // Ensure required array only mentions properties that still exist
      if (requiredArr.length > 0) {
        const remaining = requiredArr.filter((r) => r in cleanProps);
        if (remaining.length > 0) {
          out.required = remaining;
        }
      }
      continue;
    }

    // 2. Compact descriptions
    if (key === "description" && typeof val === "string") {
      out.description = compactDescription(val, maxLen);
      continue;
    }

    // 3. Handle array items
    if (key === "items" && val && typeof val === "object") {
      out.items = pruneMcpToolSchema(val as JSONSchema, opts, depth + 1);
      continue;
    }

    // 4. Handle union branches (anyOf, oneOf, allOf)
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(val)) {
      out[key] = val.map((item) =>
        typeof item === "object" && item !== null
          ? pruneMcpToolSchema(item as JSONSchema, opts, depth + 1)
          : item,
      );
      continue;
    }

    // Recurse on general nested objects (excluding already handled special keys)
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      out[key] = pruneMcpToolSchema(val as JSONSchema, opts, depth + 1);
    } else {
      out[key] = val;
    }
  }

  return out as JSONSchema;
}
