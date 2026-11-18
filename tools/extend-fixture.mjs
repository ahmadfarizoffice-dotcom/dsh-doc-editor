#!/usr/bin/env node
/**
 * Generates `fixtures/docx_docs_renderer_feature_test_cases_extended.docx`.
 *
 * The supplied acceptance fixture *describes* images, footnotes, comments,
 * tracked changes, equations and text boxes but does not physically contain
 * them. This generator writes real OOXML for those constructs (hand-authored
 * XML, not produced by our exporter) so the engine can be regression tested on
 * them.
 */
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const require = createRequire(resolve(repo, "packages/core/package.json"));
const JSZip = require("jszip");

/* --------------------------------------------------------------- PNG image */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Deterministic 4:3 gradient PNG used for image tests. */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = Math.round((x / width) * 255);
      raw[offset + 1] = Math.round((y / height) * 255);
      raw[offset + 2] = 180;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- XML */

const NS_DECL = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
  'mc:Ignorable="w14 wp14"',
].join(" ");

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const p = (inner, pPr = "") =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const t = (text, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const INLINE_IMAGE = `
<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
  <wp:extent cx="1143000" cy="857250"/>
  <wp:effectExtent l="0" t="0" r="0" b="0"/>
  <wp:docPr id="1" name="Inline 4:3 image" descr="Gradient test image (4:3)"/>
  <wp:cNvGraphicFramePr/>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic>
      <pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1143000" cy="857250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>
    </pic:pic>
  </a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r>`;

const FLOATING_IMAGE = `
<w:r><w:drawing><wp:anchor distT="45720" distB="45720" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
  <wp:simplePos x="0" y="0"/>
  <wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>
  <wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>
  <wp:extent cx="1371600" cy="1028700"/>
  <wp:effectExtent l="0" t="0" r="0" b="0"/>
  <wp:wrapSquare wrapText="both"/>
  <wp:docPr id="2" name="Floating image" descr="Floating gradient image with square wrap"/>
  <wp:cNvGraphicFramePr/>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:pic>
      <pic:nvPicPr><pic:cNvPr id="2" name="image2.png"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="rIdImg2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="1028700"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>
    </pic:pic>
  </a:graphicData></a:graphic>
</wp:anchor></w:drawing></w:r>`;

const TEXT_BOX = `
<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251659265" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">
  <wp:simplePos x="0" y="0"/>
  <wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>
  <wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>
  <wp:extent cx="2743200" cy="914400"/>
  <wp:effectExtent l="0" t="0" r="0" b="0"/>
  <wp:wrapSquare wrapText="both"/>
  <wp:docPr id="3" name="Text box 1"/>
  <wp:cNvGraphicFramePr/>
  <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
    <wps:wsp>
      <wps:cNvSpPr><a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr>
      <wps:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm>
        <a:prstGeom prst="roundRect"/>
        <a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill>
      </wps:spPr>
      <wps:txbx><w:txbxContent>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${t("Inside the text box")}</w:p>
        <w:p>${t("Text boxes are anchored drawing objects with their own block content.")}</w:p>
      </w:txbxContent></wps:txbx>
      <wps:bodyPr/>
    </wps:wsp>
  </a:graphicData></a:graphic>
</wp:anchor></w:drawing></w:r>`;

const EQUATION = `
<w:r><m:oMath>
  <m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>
  <m:r><m:t>+</m:t></m:r>
  <m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>
  <m:r><m:t>=</m:t></m:r>
  <m:rad><m:deg/><m:e><m:r><m:t>c</m:t></m:r></m:e></m:rad>
</m:oMath></w:r>`;

const COMMENT_RANGE_START = '<w:commentRangeStart w:id="0"/>';
const COMMENT_RANGE_END = '<w:commentRangeEnd w:id="0"/>';
const COMMENT_REF =
  '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>';

const FOOTNOTE_REF = '<w:r><w:footnoteReference w:id="1"/></w:r>';
const ENDNOTE_REF = '<w:r><w:endnoteReference w:id="1"/></w:r>';

const TRACKED_INSERT = `<w:ins w:id="100" w:author="QA Fixture" w:date="2026-01-02T10:00:00Z">${t(" inserted by track changes")}</w:ins>`;
const TRACKED_DELETE = `<w:del w:id="101" w:author="QA Fixture" w:date="2026-01-02T10:05:00Z"><w:r><w:delText xml:space="preserve"> deleted by track changes</w:delText></w:r></w:del>`;

const PAGE_REF_FIELD = `
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc_extended \\h </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
${t("1")}
<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const SEQ_FIELD = `
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
${t("1")}
<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const TOC_FIELD = `
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t xml:space="preserve">References and review\t1</w:t></w:r>
<w:r><w:t xml:space="preserve">Second heading\t1</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

const TABLE = `
<w:tbl>
  <w:tblPr>
    <w:tblStyle w:val="TableGrid"/>
    <w:tblW w:w="0" w:type="auto"/>
    <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/>
  </w:tblPr>
  <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
  <w:tr>
    <w:trPr><w:tblHeader/></w:trPr>
    <w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/></w:tcPr>${p(t("Header A", '<w:color w:val="FFFFFF"/><w:b/>'))}</w:tc>
    <w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/></w:tcPr>${p(t("Header B", '<w:color w:val="FFFFFF"/><w:b/>'))}</w:tc>
    <w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/></w:tcPr>${p(t("Header C", '<w:color w:val="FFFFFF"/><w:b/>'))}</w:tc>
  </w:tr>
  <w:tr>
    <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(t("Merged across two columns"))}</w:tc>
    <w:tc>${p(t("Separate cell"))}</w:tc>
  </w:tr>
</w:tbl>`;

function documentXml() {
  return `${XML_DECL}<w:document ${NS_DECL}><w:body>
${p(t("Extended acceptance fixture", '<w:sz w:val="56"/><w:b/>'), '<w:pStyle w:val="Title"/>')}
${p(t("This document adds real OOXML constructs to the original checklist: images, notes, comments, tracked changes, an equation, a text box and a generated table of contents."))}

<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc_extended"/>${t("References and review")}</w:p>

<w:p>${t("A hyperlink to the ")}<w:hyperlink r:id="rIdHyperlink">${t("renderer test page", '<w:color w:val="0563C1"/><w:u w:val="single"/>')}</w:hyperlink>${t(" plus ")}${COMMENT_RANGE_START}${t("text under review")}${COMMENT_RANGE_END}${COMMENT_REF}${t(" with a footnote")}${FOOTNOTE_REF}${t(" and an endnote")}${ENDNOTE_REF}${t(", followed by tracked edits:")}${TRACKED_INSERT}${TRACKED_DELETE}${t(". The bookmark page is ")}${PAGE_REF_FIELD}${t(". ")}</w:p>

<w:p>${t("Inline image (4:3) follows: ")}${INLINE_IMAGE}</w:p>

<w:p>${t("This paragraph is flowed around a floating image anchored to the right margin and a text box callout.")}${FLOATING_IMAGE}${TEXT_BOX}</w:p>

<w:p>${t("Equation: ")}${EQUATION}</w:p>

<w:p>${t("Figure ")}${SEQ_FIELD}${t(". Generated caption numbering uses a SEQ field.")}</w:p>

<w:p>${t("Formatting samples: ")}<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>underline</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t>strike</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>highlight</w:t></w:r><w:r><w:t xml:space="preserve">, </w:t></w:r><w:r><w:rPr><w:color w:val="C00000"/></w:rPr><w:t>red text</w:t></w:r><w:r><w:t xml:space="preserve">, x</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t xml:space="preserve"> and H</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t>O.</w:t></w:r></w:p>

<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:bookmarkStart w:id="2" w:name="_Toc_second"/><w:bookmarkEnd w:id="2"/>${t("Second heading")}</w:p>

<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${t("Table of contents")}</w:p>
${TOC_FIELD}

<w:p><w:r><w:br w:type="page"/></w:r>${t("Content after an explicit page break.")}</w:p>

<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${t("Table with header row and merged cells")}</w:p>
${TABLE}

<w:p><w:pPr><w:pStyle w:val="Normal"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${t("Numbered item one")}</w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${t("Numbered item two")}</w:p>

<w:sectPr>
  <w:headerReference w:type="default" r:id="rIdHeader"/>
  <w:footerReference w:type="default" r:id="rIdFooter"/>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>
  <w:pgBorders w:offsetFrom="page">
    <w:top w:val="single" w:sz="6" w:space="24" w:color="4472C4"/>
    <w:left w:val="single" w:sz="6" w:space="24" w:color="4472C4"/>
    <w:bottom w:val="single" w:sz="6" w:space="24" w:color="4472C4"/>
    <w:right w:val="single" w:sz="6" w:space="24" w:color="4472C4"/>
  </w:pgBorders>
  <w:cols w:space="720"/>
  <w:docGrid w:linePitch="360"/>
</w:sectPr>
</w:body></w:document>`;
}

const STYLES = `${XML_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="56"/><w:color w:val="17365D"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="32"/><w:color w:val="2F5496"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="26"/><w:color w:val="2F5496"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `${XML_DECL}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const SETTINGS = `${XML_DECL}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const FONT_TABLE = `${XML_DECL}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Calibri"><w:charset w:val="00"/><w:family w:val="swiss"/></w:font></w:fonts>`;

const HEADER = `${XML_DECL}<w:hdr ${NS_DECL}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${t("Extended fixture header  |  ", '<w:color w:val="646464"/><w:sz w:val="16"/>')}<w:fldSimple w:instr="PAGE"/></w:p></w:hdr>`;

const FOOTER = `${XML_DECL}<w:ftr ${NS_DECL}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${t("Extended fixture footer  •  page ", '<w:sz w:val="16"/>')}<w:fldSimple w:instr="PAGE"/>${t(" of ", '<w:sz w:val="16"/>')}<w:fldSimple w:instr="NUMPAGES"/></w:p></w:ftr>`;

const FOOTNOTES = `${XML_DECL}<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${t(" Footnote text attached to the review paragraph.")}</w:p></w:footnote>
</w:footnotes>`;

const ENDNOTES = `${XML_DECL}<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r>${t(" Endnote text rendered at the end of the document.")}</w:p></w:endnote>
</w:endnotes>`;

const COMMENTS = `${XML_DECL}<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
<w:comment w:id="0" w:author="QA Fixture" w:initials="QA" w:date="2026-01-02T09:00:00Z" w:commentId="0A1B2C3D">
<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${t("This comment is attached to the reviewed text.")}</w:p>
</w:comment></w:comments>`;

const COMMENTS_EXTENDED = `${XML_DECL}<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0A1B2C3D" w15:done="0"/></w15:commentsEx>`;

const CORE = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Extended DOCX Renderer Acceptance Fixture</dc:title>
<dc:subject>Images, notes, comments, revisions, equations, text boxes, TOC</dc:subject>
<dc:creator>DSH Document Engine QA</dc:creator>
<cp:keywords>DOCX; acceptance; extended fixture</cp:keywords>
<dc:description>Generated by tools/extend-fixture.mjs from hand-authored OOXML</dc:description>
<cp:revision>1</cp:revision>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T09:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-02T09:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const APP = `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>DSH Document Engine</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`;

const ROOT_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
<Relationship Id="rIdCommentsExtended" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>
<Relationship Id="rIdHyperlink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/renderer-test?case=extended" TargetMode="External"/>
<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
<Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
</Relationships>`;

const CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const zip = new JSZip();
zip.file("_rels/.rels", ROOT_RELS);
zip.file("[Content_Types].xml", CONTENT_TYPES);
zip.file("docProps/core.xml", CORE);
zip.file("docProps/app.xml", APP);
zip.file("word/document.xml", documentXml());
zip.file("word/_rels/document.xml.rels", DOC_RELS);
zip.file("word/styles.xml", STYLES);
zip.file("word/numbering.xml", NUMBERING);
zip.file("word/settings.xml", SETTINGS);
zip.file("word/fontTable.xml", FONT_TABLE);
zip.file("word/header1.xml", HEADER);
zip.file("word/footer1.xml", FOOTER);
zip.file("word/footnotes.xml", FOOTNOTES);
zip.file("word/endnotes.xml", ENDNOTES);
zip.file("word/comments.xml", COMMENTS);
zip.file("word/commentsExtended.xml", COMMENTS_EXTENDED);
zip.file("word/media/image1.png", makePng(120, 90));
zip.file("word/media/image2.png", makePng(160, 120));

const buffer = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
});
const target = resolve(
  repo,
  "fixtures/docx_docs_renderer_feature_test_cases_extended.docx",
);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, buffer);
console.log(`Wrote ${target} (${buffer.length} bytes)`);
