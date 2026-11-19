#!/usr/bin/env node
/** Writes small sample documents used by manual checks (not part of the suite). */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const require = createRequire(path.join(repo, "packages/core/package.json"));
const JSZip = require("jszip");

const out = path.join(repo, "test-output");
await mkdir(out, { recursive: true });

const pages09 = `<?xml version="1.0" encoding="UTF-8"?>
<sf:document xmlns:sf="http://developer.apple.com/namespaces/sf">
  <sf:body>
    <sf:p><sf:span>Pages sample heading</sf:span></sf:p>
    <sf:p><sf:span>First paragraph from a Pages ’09 document.</sf:span></sf:p>
    <sf:p/>
    <sf:p><sf:span>Second paragraph with </sf:span><sf:span>split spans</sf:span><sf:span>.</sf:span></sf:p>
    <sf:table><sf:grid/></sf:table>
  </sf:body>
</sf:document>`;
const zip = new JSZip();
zip.file("index.xml", pages09);
zip.file("Metadata/DocumentIdentifier", "SAMPLE-PAGES-09");
const buffer = await zip.generateAsync({ type: "nodebuffer" });
await writeFile(path.join(out, "sample-pages-09.pages"), buffer);

const pointer = {
  doc_id: "1AbCdEfGhIjKlMnOpQrSt",
  resource_id: "1AbCdEfGhIjKlMnOpQrSt",
  email: "user@example.com",
};
await writeFile(
  path.join(out, "sample-gdoc.gdoc"),
  JSON.stringify(pointer),
  "utf8",
);

const modern = new JSZip();
// Uncompressed IWA frame carrying a protobuf length-delimited string.
const text = Buffer.from("Modern Pages preview paragraph.", "utf8");
const payload = Buffer.concat([Buffer.from([0x0a, text.length]), text]);
const frame = Buffer.concat([
  Buffer.from([
    0x01,
    payload.length & 0xff,
    (payload.length >> 8) & 0xff,
    (payload.length >> 16) & 0xff,
  ]),
  payload,
]);
modern.file("Index/Document.iwa", frame);
modern.file("Metadata/DocumentIdentifier", "SAMPLE-MODERN");
await writeFile(
  path.join(out, "sample-modern.pages"),
  await modern.generateAsync({ type: "nodebuffer" }),
);

console.log(`Wrote ${path.join(out, "sample-pages-09.pages")}`);
console.log(`Wrote ${path.join(out, "sample-modern.pages")}`);
console.log(`Wrote ${path.join(out, "sample-gdoc.gdoc")}`);
