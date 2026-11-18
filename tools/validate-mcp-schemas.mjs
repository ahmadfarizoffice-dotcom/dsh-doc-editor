#!/usr/bin/env node
/**
 * Validates the MCP tool schema manifest emitted by the server build.
 *
 * The manifest is written by the MCP server build step to
 * `apps/mcp/dist/tools.json` (a JSON array of tools, or an object with a
 * `tools` array). This script is the CI gate for it:
 *
 *   - the file must exist (unless ALLOW_MISSING_MCP_MANIFEST=1)
 *   - every tool name must match /^document_[a-z_]+$/
 *   - every tool must carry an `inputSchema` object of JSON Schema type "object"
 *   - names must be unique
 *   - the manifest must list at least 40 tools
 *
 * Usage: node tools/validate-mcp-schemas.mjs
 * Dependency-free on purpose: it is also used before dependencies are built.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const manifestPath = path.join(repoRoot, "apps", "mcp", "dist", "tools.json");
const relativeManifestPath = path
  .relative(repoRoot, manifestPath)
  .split(path.sep)
  .join("/");

const MIN_TOOL_COUNT = 40;
const NAME_PATTERN = /^document_[a-z_]+$/;

const problems = [];

function problem(where, message) {
  problems.push(where ? `${where}: ${message}` : message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts a bare tool array or a `{ tools: [...] }` envelope. */
function extractTools(manifest) {
  if (Array.isArray(manifest)) return { tools: manifest };
  if (isPlainObject(manifest) && Array.isArray(manifest.tools))
    return { tools: manifest.tools };
  return {
    error: "expected a JSON array of tools, or an object with a 'tools' array",
  };
}

function validateTool(tool, index, seenNames) {
  const where = `tools[${index}]`;
  if (!isPlainObject(tool)) {
    problem(where, "must be an object");
    return;
  }

  const name = tool.name;
  if (typeof name !== "string" || name.trim() === "") {
    problem(where, "is missing a non-empty string 'name'");
  } else {
    if (!NAME_PATTERN.test(name)) {
      problem(where, `name '${name}' does not match /^document_[a-z_]+$/`);
    }
    if (seenNames.has(name)) {
      problem(where, `duplicate tool name '${name}'`);
    }
    seenNames.add(name);
  }

  const schema = tool.inputSchema;
  if (!isPlainObject(schema)) {
    problem(where, `tool '${name ?? "?"}' is missing an 'inputSchema' object`);
    return;
  }
  if (schema.type !== "object") {
    problem(
      where,
      `tool '${name ?? "?"}' inputSchema.type must be "object" (found ${JSON.stringify(schema.type)})`,
    );
  }
  if (
    Object.hasOwn(schema, "properties") &&
    !isPlainObject(schema.properties)
  ) {
    problem(
      where,
      `tool '${name ?? "?"}' inputSchema.properties must be an object when present`,
    );
  }
  if (Object.hasOwn(schema, "required")) {
    const required = schema.required;
    if (
      !Array.isArray(required) ||
      required.some((entry) => typeof entry !== "string")
    ) {
      problem(
        where,
        `tool '${name ?? "?"}' inputSchema.required must be an array of strings when present`,
      );
    } else if (isPlainObject(schema.properties)) {
      for (const requiredName of required) {
        if (!Object.hasOwn(schema.properties, requiredName)) {
          problem(
            where,
            `tool '${name ?? "?"}' requires '${requiredName}', which is not declared in properties`,
          );
        }
      }
    }
  }
}

async function main() {
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(
        `validate-mcp-schemas: manifest not built yet (${relativeManifestPath} is missing).`,
      );
      console.warn(
        "  Build the MCP server first: `pnpm run build` (or `pnpm --filter @dsh-doc/mcp run build`).",
      );
      if (process.env.ALLOW_MISSING_MCP_MANIFEST === "1") {
        console.warn("  Continuing because ALLOW_MISSING_MCP_MANIFEST=1.");
        return;
      }
      console.error(
        "  Refusing to pass without a tool schema manifest; set ALLOW_MISSING_MCP_MANIFEST=1 to skip.",
      );
      process.exitCode = 1;
      return;
    }
    console.error(
      `validate-mcp-schemas: could not read ${relativeManifestPath}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    console.error(
      `validate-mcp-schemas: ${relativeManifestPath} is not valid JSON: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  const { tools, error: shapeError } = extractTools(manifest);
  if (shapeError) {
    console.error(
      `validate-mcp-schemas: ${relativeManifestPath} has an unsupported shape: ${shapeError}`,
    );
    process.exitCode = 1;
    return;
  }

  const seenNames = new Set();
  tools.forEach((tool, index) => validateTool(tool, index, seenNames));

  if (tools.length < MIN_TOOL_COUNT) {
    problem(
      "",
      `manifest lists ${tools.length} tool(s); at least ${MIN_TOOL_COUNT} are required`,
    );
  }

  if (problems.length > 0) {
    console.error(
      `validate-mcp-schemas: ${problems.length} problem(s) in ${relativeManifestPath}\n`,
    );
    for (const entry of problems) console.error(`  - ${entry}`);
    console.error("\nvalidate-mcp-schemas: FAILED");
    process.exitCode = 1;
    return;
  }

  console.log("validate-mcp-schemas: OK");
  console.log(`  manifest      : ${relativeManifestPath}`);
  console.log(`  tools         : ${tools.length} (minimum ${MIN_TOOL_COUNT})`);
  console.log(`  unique names  : ${seenNames.size}`);
  console.log("  every tool has a JSON Schema 'object' inputSchema");

  const resources =
    isPlainObject(manifest) && Array.isArray(manifest.resources)
      ? manifest.resources
      : null;
  const prompts =
    isPlainObject(manifest) && Array.isArray(manifest.prompts)
      ? manifest.prompts
      : null;
  if (resources) console.log(`  resources     : ${resources.length}`);
  if (prompts) console.log(`  prompts       : ${prompts.length}`);
}

await main();
