#!/usr/bin/env node
/** Validates the agent integration packages (Claude Code, Codex, Antigravity, OpenCode) without network access. */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

const json = async (relative) => {
  try {
    return JSON.parse(await readFile(path.join(repo, relative), "utf8"));
  } catch (error) {
    problems.push(`${relative}: ${error.message}`);
    return undefined;
  }
};

const claude = await json(
  "integrations/claude-code/.claude-plugin/plugin.json",
);
check(claude?.name === "dsh-doc", "Claude plugin name must be dsh-doc");
check(Boolean(claude?.version), "Claude plugin needs a version");
check(Boolean(claude?.description), "Claude plugin needs a description");
check(claude?.license === "MIT", "Claude plugin must declare MIT");

const marketplace = await json(".claude-plugin/marketplace.json");
check(
  marketplace?.plugins?.[0]?.name === "dsh-doc",
  "root marketplace must list dsh-doc",
);
const source = marketplace?.plugins?.[0]?.source;
check(
  typeof source === "string" && source.startsWith("./"),
  "root marketplace source must be a relative directory",
);
if (typeof source === "string") {
  const pluginDir = path.join(repo, source);
  const exists = await stat(path.join(pluginDir, ".claude-plugin/plugin.json"))
    .then(() => true)
    .catch(() => false);
  check(
    exists,
    `marketplace source ${source} must contain .claude-plugin/plugin.json`,
  );
  const skills = await readdir(path.join(pluginDir, "skills")).catch(() => []);
  check(
    skills.length === 12,
    `Claude plugin must carry 12 skills, found ${skills.length}`,
  );
}

const mcp = await json("integrations/claude-code/.mcp.json");
check(
  Boolean(mcp?.mcpServers?.["dsh-doc"]),
  "Claude .mcp.json must declare dsh-doc",
);
check(
  JSON.stringify(mcp?.mcpServers?.["dsh-doc"]?.args ?? []).includes(
    "start-mcp.mjs",
  ),
  "Claude MCP server must use scripts/start-mcp.mjs",
);

await json("integrations/claude-code/.claude-plugin/marketplace.json");
await json("integrations/antigravity/mcp_config.json");
await json("integrations/opencode/opencode.json");

const codexToml = await readFile(
  path.join(repo, "integrations/codex/config.toml"),
  "utf8",
).catch(() => "");
check(
  codexToml.includes("[mcp_servers.dsh-doc]"),
  "Codex config.toml must declare [mcp_servers.dsh-doc]",
);
check(codexToml.includes("command"), "Codex config.toml needs a command");

const scripts = [
  "integrations/shared/resolve-repo.mjs",
  "integrations/shared/cli-bridge.mjs",
  "integrations/claude-code/scripts/start-mcp.mjs",
  "integrations/claude-code/scripts/sync-skills.mjs",
  "integrations/codex/install.mjs",
  "integrations/codex/install.test.mjs",
  "integrations/opencode/.opencode/plugin/dsh-doc.js",
];
for (const relative of scripts) {
  const file = path.join(repo, relative);
  const text = await readFile(file, "utf8").catch(() => "");
  check(text.length > 0, `${relative} is missing or empty`);
}

for (const command of ["read-doc.md", "convert-doc.md", "review-doc.md"]) {
  const text = await readFile(
    path.join(repo, "integrations/claude-code/commands", command),
    "utf8",
  ).catch(() => "");
  check(
    text.includes("$ARGUMENTS"),
    `Claude command ${command} must accept $ARGUMENTS`,
  );
}

const install = await readFile(path.join(repo, "INSTALL.md"), "utf8").catch(
  () => "",
);
for (const needle of [
  "dsh-doc-editor-plugin",
  "plugin_manager",
  "claude-code",
  "codex",
  "antigravity",
  "opencode",
  "web:start",
]) {
  check(install.includes(needle), `INSTALL.md must mention ${needle}`);
}

if (problems.length > 0) {
  console.error(`check-integrations: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("check-integrations: OK");
console.log("  claude plugin : dsh-doc (12 skills, 3 commands, marketplace)");
console.log("  codex         : config.toml + installer");
console.log("  antigravity   : mcp_config.json");
console.log("  opencode      : opencode.json + plugin");
console.log("  install guide : INSTALL.md");
