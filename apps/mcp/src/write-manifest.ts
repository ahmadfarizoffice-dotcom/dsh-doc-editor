#!/usr/bin/env node
/** Emits the tool manifest consumed by CI validation and agent tool loaders. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolManifest } from "@dsh-doc/core/tools";
import { PROMPTS, RESOURCES } from "@dsh-doc/core/tools";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = {
  ...buildToolManifest(),
  generatedAt: new Date().toISOString(),
  resources: RESOURCES,
  prompts: PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
  })),
};

await mkdir(here, { recursive: true });
await writeFile(
  path.join(here, "tools.json"),
  JSON.stringify(manifest, null, 2),
  "utf8",
);
process.stdout.write(
  `wrote ${path.join(here, "tools.json")} (${manifest.tools.length} tools)\n`,
);
