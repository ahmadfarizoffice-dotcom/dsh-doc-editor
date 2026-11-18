#!/usr/bin/env node
/**
 * Validates the agent skill pack in `skills/`.
 *
 * Every `skills/<name>/SKILL.md` must:
 *   - start with a closed YAML frontmatter block
 *   - declare `name`, `description`, `allowed-tools` and `license`
 *   - use a name that matches its directory
 *   - list only canonical MCP tools in `allowed-tools`
 *   - contain every required body section, in order
 *   - provide at least three example prompts
 *   - document its tools in the "Required tools" table, with exactly the
 *     tools it is allowed to use
 *   - number its instructions
 *   - contain no placeholder text ("TODO", "TBD", "FIXME", "lorem ipsum")
 *
 * Usage: node tools/check-skills.mjs
 * Exits 0 when every skill is valid, 1 with a per-file report otherwise.
 *
 * Dependency-free on purpose: this runs in CI before `pnpm install`.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const skillsRoot = path.join(repoRoot, "skills");

/** Canonical MCP tool inventory. A skill may only allow-list these names. */
const CANONICAL_TOOLS = new Set([
  // Lifecycle
  "document_create",
  "document_open",
  "document_save",
  "document_save_as",
  "document_close",
  "document_get_metadata",
  "document_list_formats",
  // Reading
  "document_get_content",
  "document_get_outline",
  "document_get_text",
  "document_get_selection",
  "document_get_page_info",
  "document_search",
  // Editing
  "document_insert_text",
  "document_replace_text",
  "document_delete_range",
  "document_format_text",
  "document_format_paragraph",
  "document_apply_style",
  "document_insert_heading",
  "document_insert_list",
  "document_insert_table",
  "document_edit_table",
  "document_insert_image",
  "document_insert_hyperlink",
  "document_insert_page_break",
  "document_insert_section_break",
  "document_edit_header",
  "document_edit_footer",
  // Advanced
  "document_add_comment",
  "document_track_change",
  "document_accept_change",
  "document_reject_change",
  "document_insert_footnote",
  "document_insert_toc",
  "document_insert_equation",
  "document_compare",
  "document_get_revision_history",
  "document_undo",
  "document_redo",
  // Conversion
  "document_convert",
  "document_export_pdf",
  "document_import",
  "document_export",
  // AI
  "document_ai_summarize",
  "document_ai_rewrite",
  "document_ai_translate",
  "document_ai_review",
  "document_ai_generate_content",
  "document_ai_suggest_edits",
]);

/** The skill pack ships exactly these skills; the routing table documents them. */
const EXPECTED_SKILLS = [
  "document-reader",
  "document-creator",
  "document-editor",
  "document-formatter",
  "document-converter",
  "document-reviewer",
  "document-proofreader",
  "document-summarizer",
  "document-table-manager",
  "document-reference-manager",
  "document-layout-manager",
  "document-ai-assistant",
];

/** Body sections every skill must contain, in this order. */
const REQUIRED_SECTIONS = [
  "## Description",
  "## When to use it",
  "## Supported input formats",
  "## Required tools",
  "## Instructions",
  "## Example prompts",
  "## Expected outputs",
  "## Error handling",
  "## Limitations",
  "## Safety considerations",
];

const REQUIRED_FRONTMATTER = [
  "name",
  "description",
  "allowed-tools",
  "license",
];

const FORBIDDEN_PATTERNS = [
  { pattern: /\bTODO\b/i, label: 'placeholder "TODO"' },
  { pattern: /\bTBD\b/i, label: 'placeholder "TBD"' },
  { pattern: /\bFIXME\b/i, label: 'placeholder "FIXME"' },
  { pattern: /\blorem ipsum\b/i, label: 'placeholder "lorem ipsum"' },
];

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Splits a SKILL.md into frontmatter key/value pairs and the markdown body.
 * Supports simple scalars (`key: value`), quoted scalars and block lists
 * (`key:` followed by `- item` lines) so contributors are not forced into one
 * YAML style.
 */
function parseSkill(source) {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return {
      error:
        "file must start with a YAML frontmatter block (first line must be '---')",
    };
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (closing === -1) {
    return { error: "frontmatter is not closed with a second '---' line" };
  }

  const data = {};
  let currentKey = null;
  for (let index = 1; index < closing; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    const keyMatch = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(raw);
    if (keyMatch) {
      const key = keyMatch[1];
      if (Object.hasOwn(data, key)) {
        return { error: `frontmatter declares '${key}' more than once` };
      }
      data[key] = { scalar: (keyMatch[2] ?? "").trim(), items: [] };
      currentKey = key;
      continue;
    }

    const itemMatch = /^\s*-\s+(.+)$/.exec(raw);
    if (itemMatch && currentKey) {
      data[currentKey].items.push(itemMatch[1].trim());
      continue;
    }

    return {
      error: `unrecognized frontmatter line ${index + 1}: ${JSON.stringify(raw)} (only 'key: value' and '- item' lines are supported)`,
    };
  }

  const body = lines.slice(closing + 1).join("\n");
  return { data, body, frontmatterLineCount: closing + 1 };
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function readList(entry) {
  const items =
    entry.items.length > 0
      ? entry.items
      : entry.scalar
        ? entry.scalar.split(",")
        : [];
  return items
    .map((item) => stripQuotes(item.replace(/^["'`]|["'`]$/g, "")))
    .filter(Boolean);
}

/** Returns the text of the section that starts at `heading`, ending at the next `## ` heading. */
function sectionText(body, heading) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Extracts first-column tool names from a markdown table body. */
function tableToolNames(section) {
  const rows = section
    .split("\n")
    .filter((line) => line.trim().startsWith("|"));
  const names = [];
  for (const row of rows) {
    const cells = row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const first = cells[0].replace(/`/g, "").trim();
    if (
      !first ||
      first === "Tool" ||
      first === "Error code" ||
      /^-+$/.test(first)
    )
      continue;
    names.push(first);
  }
  return names;
}

function countListItems(section) {
  return section
    .split("\n")
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

function countNumberedItems(section) {
  return section.split("\n").filter((line) => /^\s*\d+\.\s+\S/.test(line))
    .length;
}

async function collectSkillFiles() {
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { errors: ["skills/ does not exist"], files: [] };
    }
    throw error;
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files = [];
  for (const dir of dirs) {
    files.push({ dir, file: path.join(skillsRoot, dir, "SKILL.md") });
  }
  return { dirs, files };
}

function validateSkill({ dir, source, errors, stats }) {
  const parsed = parseSkill(source);
  if (parsed.error) {
    errors.push({ dir, message: parsed.error });
    return;
  }
  const { data, body } = parsed;

  for (const key of REQUIRED_FRONTMATTER) {
    if (!Object.hasOwn(data, key)) {
      errors.push({
        dir,
        message: `frontmatter is missing required key '${key}'`,
      });
    } else if (!data[key].scalar && data[key].items.length === 0) {
      errors.push({ dir, message: `frontmatter key '${key}' is empty` });
    }
  }

  const name = data.name ? stripQuotes(data.name.scalar) : "";
  if (name) {
    if (!NAME_PATTERN.test(name)) {
      errors.push({
        dir,
        message: `frontmatter name '${name}' must be kebab-case (a-z, 0-9, '-')`,
      });
    }
    if (name !== dir) {
      errors.push({
        dir,
        message: `frontmatter name '${name}' does not match directory '${dir}'`,
      });
    }
  }

  const description = data.description
    ? stripQuotes(data.description.scalar)
    : "";
  if (description) {
    if (description.length < 20) {
      errors.push({
        dir,
        message:
          "frontmatter description is too short to be useful (< 20 characters)",
      });
    }
    if (description.length > 500) {
      errors.push({
        dir,
        message:
          "frontmatter description exceeds 500 characters; keep it to one sentence",
      });
    }
    if (!description.endsWith(".")) {
      errors.push({
        dir,
        message:
          "frontmatter description must be one sentence ending with a period",
      });
    }
  }

  const license = data.license ? stripQuotes(data.license.scalar) : "";
  if (license && license !== "MIT") {
    errors.push({
      dir,
      message: `frontmatter license must be 'MIT' (found '${license}')`,
    });
  }

  const allowedTools = data["allowed-tools"]
    ? readList(data["allowed-tools"])
    : [];
  const seenTools = new Set();
  for (const tool of allowedTools) {
    if (!CANONICAL_TOOLS.has(tool)) {
      errors.push({
        dir,
        message: `allowed-tools lists '${tool}', which is not a canonical MCP tool`,
      });
    }
    if (seenTools.has(tool)) {
      errors.push({
        dir,
        message: `allowed-tools lists '${tool}' more than once`,
      });
    }
    seenTools.add(tool);
  }

  // Section presence and order.
  const positions = [];
  for (const heading of REQUIRED_SECTIONS) {
    const index = body.split("\n").findIndex((line) => line.trim() === heading);
    if (index === -1) {
      errors.push({ dir, message: `missing required section '${heading}'` });
    } else {
      positions.push({ heading, index });
    }
  }
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i].index < positions[i - 1].index) {
      errors.push({
        dir,
        message: `section '${positions[i].heading}' appears before '${positions[i - 1].heading}'`,
      });
    }
  }

  // Instructions must be numbered and concrete.
  const instructions = sectionText(body, "## Instructions");
  if (instructions !== null) {
    const numbered = countNumberedItems(instructions);
    if (numbered < 3) {
      errors.push({
        dir,
        message: `## Instructions must be a numbered list with at least 3 steps (found ${numbered})`,
      });
    }
    stats.instructionSteps += numbered;
  }

  // Example prompts.
  const examples = sectionText(body, "## Example prompts");
  if (examples !== null) {
    const prompts = countListItems(examples);
    if (prompts < 3) {
      errors.push({
        dir,
        message: `## Example prompts must contain at least 3 prompts (found ${prompts})`,
      });
    }
    stats.examplePrompts += prompts;
  }

  // Required tools table must document exactly the allowed tools.
  const toolsSection = sectionText(body, "## Required tools");
  if (toolsSection !== null) {
    const documented = tableToolNames(toolsSection);
    if (documented.length === 0) {
      errors.push({
        dir,
        message:
          "## Required tools must contain a 'tool | purpose' markdown table",
      });
    }
    const documentedSet = new Set(documented);
    for (const tool of documented) {
      if (!CANONICAL_TOOLS.has(tool)) {
        errors.push({
          dir,
          message: `## Required tools documents '${tool}', which is not a canonical MCP tool`,
        });
      }
      if (!seenTools.has(tool)) {
        errors.push({
          dir,
          message: `## Required tools documents '${tool}', but allowed-tools does not list it`,
        });
      }
    }
    for (const tool of allowedTools) {
      if (!documentedSet.has(tool)) {
        errors.push({
          dir,
          message: `allowed-tools lists '${tool}', but ## Required tools does not document it`,
        });
      }
    }
    stats.tools += documented.length;
  }

  // Error handling table.
  const errorSection = sectionText(body, "## Error handling");
  if (errorSection !== null) {
    const rows = tableToolNames(errorSection);
    if (rows.length === 0) {
      errors.push({
        dir,
        message:
          "## Error handling must contain an 'error code | meaning | recovery' table",
      });
    }
    stats.errorRows += rows.length;
  }

  // Placeholder text anywhere in the file.
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      errors.push({ dir, message: `contains forbidden ${label}` });
    }
  }

  stats.skills += 1;
  stats.allowedTools += allowedTools.length;
}

async function main() {
  const errors = [];
  const stats = {
    skills: 0,
    examplePrompts: 0,
    instructionSteps: 0,
    tools: 0,
    allowedTools: 0,
    errorRows: 0,
  };

  const { dirs, files } = await collectSkillFiles();
  if (files.length === 0) {
    errors.push({ dir: "skills", message: "no skill directories found" });
  }

  for (const expected of EXPECTED_SKILLS) {
    if (!dirs.includes(expected)) {
      errors.push({
        dir: "skills",
        message: `missing expected skill directory '${expected}'`,
      });
    }
  }
  for (const dir of dirs) {
    if (!EXPECTED_SKILLS.includes(dir)) {
      errors.push({
        dir: "skills",
        message: `unexpected skill directory '${dir}' (not part of the documented pack)`,
      });
    }
  }

  for (const { dir, file } of files) {
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        errors.push({ dir, message: "missing SKILL.md" });
      } else {
        errors.push({
          dir,
          message: `could not read SKILL.md: ${error.message}`,
        });
      }
      continue;
    }
    validateSkill({ dir, source, errors, stats });
  }

  // The routing README must exist and mention every shipped skill.
  try {
    const readme = await readFile(path.join(skillsRoot, "README.md"), "utf8");
    for (const skill of EXPECTED_SKILLS) {
      if (!readme.includes(skill)) {
        errors.push({
          dir: "skills",
          message: `README.md does not mention '${skill}'`,
        });
      }
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      errors.push({ dir: "skills", message: "README.md is missing" });
    } else {
      errors.push({
        dir: "skills",
        message: `README.md could not be read: ${error.message}`,
      });
    }
  }

  if (errors.length > 0) {
    const byDir = new Map();
    for (const error of errors) {
      if (!byDir.has(error.dir)) byDir.set(error.dir, []);
      byDir.get(error.dir).push(error.message);
    }
    console.error(
      `check-skills: ${errors.length} problem(s) across ${byDir.size} file(s)\n`,
    );
    for (const [dir, messages] of [...byDir.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.error(`  ${dir}/`);
      for (const message of messages) console.error(`    - ${message}`);
    }
    console.error("\ncheck-skills: FAILED");
    process.exitCode = 1;
    return;
  }

  console.log("check-skills: OK");
  console.log(`  skills checked        : ${stats.skills}`);
  console.log(`  canonical tools       : ${CANONICAL_TOOLS.size}`);
  console.log(`  allowed-tool entries  : ${stats.allowedTools}`);
  console.log(`  documented tool rows  : ${stats.tools}`);
  console.log(`  example prompts       : ${stats.examplePrompts}`);
  console.log(`  numbered instructions : ${stats.instructionSteps}`);
  console.log(`  error-handling rows   : ${stats.errorRows}`);
  console.log(
    `  required sections     : ${REQUIRED_SECTIONS.length} per skill`,
  );
}

await main();
