/**
 * Binary fixtures built in-process for adapter tests.
 *
 * - `buildCompoundFile` / `buildMiniCompoundFile` implement the OLE compound
 *   file container (FAT, DIFAT, directory, mini FAT and mini stream).
 * - `buildWordDocumentStream` builds a Word 97 FIB plus a CLX piece table with
 *   one CP1252 and one UTF-16LE piece.
 * - `buildXlsxPackage` / `buildPptxPackage` build minimal OOXML ZIP packages.
 */
import JSZip from "jszip";

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

/** 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const SECTOR = 512;
const MINI_SECTOR = 64;

function writeHeader(
  file: Buffer,
  options: {
    firstDirSector: number;
    firstMiniFatSector: number;
    numMiniFatSectors: number;
    numFatSectors: number;
    miniStreamCutoff?: number;
  },
): void {
  file.writeUInt32BE(0xd0cf11e0, 0);
  file.writeUInt32BE(0xa1b11ae1, 4);
  file.writeUInt16LE(0x003e, 24); // minor version
  file.writeUInt16LE(0x0003, 26); // major version 3 (512-byte sectors)
  file.writeUInt16LE(0xfffe, 28); // little endian
  file.writeUInt16LE(9, 30); // sector shift 512
  file.writeUInt16LE(6, 32); // mini sector shift 64
  file.writeUInt32LE(0, 40); // directory sector count (v3 must be 0)
  file.writeUInt32LE(options.numFatSectors, 44);
  file.writeUInt32LE(options.firstDirSector, 48);
  file.writeUInt32LE(0, 52); // transaction signature
  file.writeUInt32LE(options.miniStreamCutoff ?? 4096, 56);
  file.writeUInt32LE(options.firstMiniFatSector, 60);
  file.writeUInt32LE(options.numMiniFatSectors, 64);
  file.writeUInt32LE(END_OF_CHAIN, 68); // first DIFAT sector
  file.writeUInt32LE(0, 72); // DIFAT sector count
  for (let index = 0; index < 109; index += 1) {
    file.writeUInt32LE(index === 0 ? 0 : FREE_SECTOR, 76 + index * 4);
  }
}

function writeDirectoryEntry(
  directory: Buffer,
  index: number,
  entry: { name: string; type: number; child: number; startSector: number; size: number },
): void {
  const offset = index * 128;
  const name = Buffer.from(`${entry.name}\0`, "utf16le");
  name.copy(directory, offset, 0, Math.min(64, name.length));
  directory.writeUInt16LE(Math.min(64, name.length), offset + 64);
  directory.writeUInt8(entry.type, offset + 66);
  directory.writeUInt8(1, offset + 67); // black node
  directory.writeUInt32LE(FREE_SECTOR, offset + 68); // left sibling
  directory.writeUInt32LE(FREE_SECTOR, offset + 72); // right sibling
  directory.writeUInt32LE(entry.child, offset + 76);
  directory.writeUInt32LE(entry.startSector, offset + 116);
  directory.writeUInt32LE(entry.size, offset + 120);
  directory.writeUInt32LE(0, offset + 124);
}

/** Builds a compound file whose streams all live in regular FAT sectors. */
export function buildCompoundFile(streams: Array<{ name: string; data: Buffer }>): Buffer {
  const placements: Array<{ start: number; count: number }> = [];
  let nextSector = 2; // 0 = FAT, 1 = directory
  for (const stream of streams) {
    const count = Math.max(1, Math.ceil(stream.data.length / SECTOR));
    placements.push({ start: nextSector, count });
    nextSector += count;
  }
  const totalSectors = nextSector;
  const file = Buffer.alloc((totalSectors + 1) * SECTOR);
  writeHeader(file, {
    firstDirSector: 1,
    firstMiniFatSector: END_OF_CHAIN,
    numMiniFatSectors: 0,
    numFatSectors: 1,
  });

  const fat = Buffer.alloc(SECTOR, 0xff);
  const setFat = (sector: number, value: number) => fat.writeUInt32LE(value, sector * 4);
  setFat(0, 0xfffffffd); // FATSECT
  setFat(1, END_OF_CHAIN); // directory chain end
  placements.forEach((placement) => {
    for (let index = 0; index < placement.count; index += 1) {
      const last = index === placement.count - 1;
      setFat(placement.start + index, last ? END_OF_CHAIN : placement.start + index + 1);
    }
  });
  fat.copy(file, SECTOR * 1);

  const directory = Buffer.alloc(SECTOR);
  writeDirectoryEntry(directory, 0, { name: "Root Entry", type: 5, child: 1, startSector: END_OF_CHAIN, size: 0 });
  streams.forEach((stream, index) => {
    writeDirectoryEntry(directory, index + 1, {
      name: stream.name,
      type: 2,
      child: FREE_SECTOR,
      startSector: placements[index].start,
      size: stream.data.length,
    });
  });
  directory.copy(file, SECTOR * 2);

  streams.forEach((stream, index) => {
    stream.data.copy(file, (placements[index].start + 1) * SECTOR);
  });
  return file;
}

/** Builds a compound file whose single small stream lives in the mini stream. */
export function buildMiniCompoundFile(name: string, data: Buffer): Buffer {
  if (data.length >= 4096) throw new Error("mini stream fixture must be smaller than 4096 bytes");
  // 0 = FAT, 1 = directory, 2 = mini FAT, 3 = mini stream.
  const file = Buffer.alloc(5 * SECTOR);
  writeHeader(file, {
    firstDirSector: 1,
    firstMiniFatSector: 2,
    numMiniFatSectors: 1,
    numFatSectors: 1,
  });

  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(END_OF_CHAIN, 4);
  fat.writeUInt32LE(END_OF_CHAIN, 8);
  fat.writeUInt32LE(END_OF_CHAIN, 12);
  fat.copy(file, SECTOR);

  const miniFat = Buffer.alloc(SECTOR, 0xff);
  const miniSectors = Math.max(1, Math.ceil(data.length / MINI_SECTOR));
  for (let index = 0; index < miniSectors; index += 1) {
    miniFat.writeUInt32LE(index === miniSectors - 1 ? END_OF_CHAIN : index + 1, index * 4);
  }
  miniFat.copy(file, SECTOR * 3);

  const miniStream = Buffer.alloc(SECTOR);
  data.copy(miniStream, 0);
  miniStream.copy(file, SECTOR * 4);

  const directory = Buffer.alloc(SECTOR);
  writeDirectoryEntry(directory, 0, {
    name: "Root Entry",
    type: 5,
    child: 1,
    startSector: 3,
    size: miniSectors * MINI_SECTOR,
  });
  writeDirectoryEntry(directory, 1, {
    name,
    type: 2,
    child: FREE_SECTOR,
    startSector: 0,
    size: data.length,
  });
  directory.copy(file, SECTOR * 2);
  return file;
}

/**
 * Builds a WordDocument stream with a Word 97 FIB and a CLX piece table:
 * piece 0 is compressed CP1252 ("Hello legacy "), piece 1 is UTF-16LE ("world\r").
 */
export function buildWordDocumentStream(): Buffer {
  const stream = Buffer.alloc(6144);
  const textOffset1 = 0x0500;
  const textOffset2 = 0x0600;
  const clxOffset = 0x0400;
  const compressedText = Buffer.from("Hello legacy ", "latin1");
  const utf16Text = Buffer.from("world\r", "utf16le");
  compressedText.copy(stream, textOffset1);
  utf16Text.copy(stream, textOffset2);

  stream.writeUInt16LE(0xa5ec, 0); // wIdent
  stream.writeUInt16LE(0x00c1, 2); // nFib = Word 97
  stream.writeUInt16LE(0x0409, 6); // lid
  stream.writeUInt16LE(0x0004, 10); // fComplex
  stream.writeInt32LE(textOffset1, 24); // fcMin
  stream.writeInt32LE(textOffset2 + utf16Text.length, 28); // fcMac

  const cswOffset = 32;
  stream.writeUInt16LE(14, cswOffset);
  const cslwOffset = cswOffset + 2 + 14 * 2;
  stream.writeUInt16LE(22, cslwOffset);
  const cbOffset = cslwOffset + 2 + 22 * 4;
  stream.writeUInt16LE(93, cbOffset);
  const rgFcLcbOffset = cbOffset + 2;

  const cps = [0, compressedText.length, compressedText.length + 6];
  const plcLength = cps.length * 4 + 2 * 8;
  let offset = clxOffset;
  stream.writeUInt8(0x02, offset); // clxtPlcfpcd
  offset += 1;
  stream.writeUInt32LE(plcLength, offset);
  offset += 4;
  for (const cp of cps) {
    stream.writeUInt32LE(cp, offset);
    offset += 4;
  }
  // PCD 0: compressed (bit 30), fc = byte offset * 2.
  stream.writeUInt16LE(0, offset);
  stream.writeUInt32LE(0x40000000 | (textOffset1 * 2), offset + 2);
  stream.writeUInt16LE(0, offset + 6);
  offset += 8;
  // PCD 1: UTF-16LE, fc = byte offset.
  stream.writeUInt16LE(0, offset);
  stream.writeUInt32LE(textOffset2, offset + 2);
  stream.writeUInt16LE(0, offset + 6);

  stream.writeUInt32LE(clxOffset, rgFcLcbOffset + 33 * 8);
  stream.writeUInt32LE(plcLength + 5, rgFcLcbOffset + 33 * 8 + 4);
  return stream;
}

/** A complete minimal .doc compound file using the regular FAT path. */
export function buildLegacyDocFile(): Buffer {
  return buildCompoundFile([{ name: "WordDocument", data: buildWordDocumentStream() }]);
}

/* --------------------------------------------------------------- XLSX */

const XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Minimal two-sheet workbook with shared strings, a formula and a column width. */
export async function buildXlsxPackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${XLSX_NS}" xmlns:r="${R_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R_NS}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${XLSX_NS}" count="3" uniqueCount="3"><si><t>Alpha</t></si><si><t>Beta</t></si><si><r><t>Gamma</t></r></si></sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${XLSX_NS}"><cols><col min="1" max="1" width="10" customWidth="1"/></cols><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B1:B1)</f><v>42</v></c></row>
    </sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${XLSX_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row></sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/* --------------------------------------------------------------- PPTX */

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function slideXml(options: { title: string; points: string[]; table: boolean; picture: boolean; chart: boolean }): string {
  const points = options.points
    .map((point) => `<a:p><a:r><a:t>${point}</a:t></a:r></a:p>`)
    .join("");
  const table = options.table
    ? `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>C1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>C2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    : "";
  const picture = options.picture
    ? `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture" descr="dot"/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>`
    : "";
  const chart = options.chart
    ? `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>${options.title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${points}</p:txBody></p:sp>
    ${table}${picture}${chart}
  </p:spTree></p:cSld></p:sld>`;
}

/** Minimal two-slide presentation with text, a table, a picture and a chart. */
export async function buildPptxPackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${R_NS}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${R_NS}/slide" Target="slides/slide2.xml"/></Relationships>`,
  );
  zip.file(
    "ppt/slides/slide1.xml",
    slideXml({ title: "Slide title", points: ["Point one", "Point two"], table: true, picture: true, chart: true }),
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId2" Type="${R_NS}/image" Target="../media/image1.png"/></Relationships>`,
  );
  zip.file("ppt/slides/slide2.xml", slideXml({ title: "Second slide", points: ["Only point"], table: false, picture: false, chart: false }));
  zip.file("ppt/media/image1.png", PNG_1X1);
  return zip.generateAsync({ type: "nodebuffer" });
}
