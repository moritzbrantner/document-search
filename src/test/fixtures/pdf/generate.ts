// Generator for the synthetic PDF fixtures of the #22 acceptance tests.
//
// Every fixture is written byte by byte: PDF 1.4, uncompressed content streams, a correct
// cross-reference table and the standard Type1 font Helvetica with WinAnsiEncoding (non-ASCII
// characters are written as octal escapes of their WinAnsi codes). No PDF library is involved.
//
// Regenerate with `bun src/test/fixtures/pdf/generate.ts`; the acceptance test checks that the
// committed files equal `buildPdfFixtures()` byte for byte and pins their SHA-256 hashes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Text lines per physical page; an empty array is a page without a content stream. */
type PageLines = readonly string[];

const HEADER = "%PDF-1.4\n%âãÏÓ\n";
const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** WinAnsiEncoding agrees with Latin-1 for U+00A0..U+00FF, which covers every fixture character. */
function pdfString(text: string): string {
  let out = "(";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === "(" || char === ")") {
      out += `\\${char}`;
    } else if (code >= 0x20 && code < 0x7f) {
      out += char;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      throw new Error(`Character U+${code.toString(16)} is outside the fixture encoding.`);
    }
  }
  return `${out})`;
}

function stream(dictionaryEntries: string, data: string): string {
  return `<< ${dictionaryEntries}${dictionaryEntries ? " " : ""}/Length ${data.length} >>\nstream\n${data}\nendstream`;
}

function textContent(lines: PageLines): string {
  // One Tj per line, lines 28pt apart, so every line is one text item on its own baseline.
  const operations = ["BT", "/F1 12 Tf", "72 720 Td"];
  lines.forEach((line, index) => {
    if (index > 0) operations.push("0 -28 Td");
    operations.push(`${pdfString(line)} Tj`);
  });
  operations.push("ET");
  return operations.join("\n");
}

/** Serializes numbered objects (object n is `objects[n - 1]`) with a correct xref table. */
function assemble(objects: readonly string[], trailerEntries: string): Uint8Array {
  let body = HEADER;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerEntries} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  // Every character is below U+0100, so Latin-1 maps characters to bytes one to one.
  return new Uint8Array(Buffer.from(body, "latin1"));
}

/** Catalog (1), page tree (2), font (3), then per page a page object and optional contents. */
function textPdf(pages: readonly PageLines[], trailerEntries = ""): Uint8Array {
  const objects: string[] = ["", "", FONT];
  const pageRefs: string[] = [];
  for (const lines of pages) {
    const pageNumber = objects.length + 1;
    pageRefs.push(`${pageNumber} 0 R`);
    if (lines.length === 0) {
      objects.push(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> >>",
      );
    } else {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`,
      );
      objects.push(stream("", textContent(lines)));
    }
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;
  return assemble(objects, trailerEntries);
}

/** One page that paints a 2x2 grayscale image and contains no text operators at all. */
function imageOnlyPdf(): Uint8Array {
  return assemble(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
      stream("", "q\n200 0 0 200 72 500 cm\n/Im1 Do\nQ"),
      stream(
        "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode",
        "00FFFF00>",
      ),
    ],
    "",
  );
}

/**
 * A text PDF whose trailer references a Standard security handler (V1/R2, RC4 40-bit). The /U
 * entry does not match the empty user password, so opening the file requires a password.
 */
function encryptedPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    FONT,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    stream("", textContent(["This sentence is behind a password."])),
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${"5a".repeat(32)}> /U <${"c3".repeat(32)}> >>`,
  ];
  const id = "0123456789abcdef0123456789abcdef";
  return assemble(objects, ` /Encrypt 6 0 R /ID [<${id}> <${id}>]`);
}

/** A PDF header followed by a truncated object: no catalog, no xref table, no trailer. */
function malformedPdf(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Length 512 >>\nstream\nBT /F1 12 Tf (truncated before the end",
      "latin1",
    ),
  );
}

/** Fixture name -> bytes. Content is specified independently in the acceptance test. */
export function buildPdfFixtures(): Record<string, Uint8Array> {
  return {
    "text-multipage.pdf": textPdf([
      ["Quarterly harbour ledger", "The quartzite pelican nests on the first page."],
      ["Café owners record the Größe of every loaf.", "A marigold lantern hangs by the door."],
      [],
      [
        "Late entries mention the obsidian walrus.",
        "A marigold lantern hangs by the door.",
        "The closing remark mentions velvet",
      ],
      ["thunderclap weather ends the ledger."],
    ]),
    "neighbour.pdf": textPdf([["The neighbouring kingfisher survives the bad files."]]),
    "over-limit.pdf": textPdf([
      ["Overflow ledger page one mentions saffron."],
      ["Overflow ledger page two mentions saffron."],
      ["Overflow ledger page three mentions saffron."],
    ]),
    "image-only.pdf": imageOnlyPdf(),
    "encrypted.pdf": encryptedPdf(),
    "malformed.pdf": malformedPdf(),
  };
}

if (import.meta.main) {
  for (const [name, bytes] of Object.entries(buildPdfFixtures())) {
    writeFileSync(join(import.meta.dir, name), bytes);
  }
}
