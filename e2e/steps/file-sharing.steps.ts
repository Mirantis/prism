/**
 * File Sharing Step Definitions — web UI upload, chips, download, and the
 * agent reading an uploaded file.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import { HomePage } from '../pages/home.page';
import { expireAttachmentContent } from '../support/db-helper';

const { When, Then } = createBdd();

// Tests run sequentially (workers: 1), so a module-level handle is safe.
let lastDownload: Download | undefined;
let lastExpiredAttachmentId: string | undefined;

When(
  'I attach a text file named {string} containing {string}',
  async ({ page }, name: string, content: string) => {
    const homePage = new HomePage(page);
    await homePage.attachFile({ name, mimeType: 'text/plain', content });
    // Wait for the chip to register so the send button correctly blocks on the
    // upload finishing instead of racing a text-only send.
    await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
  },
);

Then('I should see {string} as an attachment in the composer', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
});

When('I remove the attachment {string}', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await homePage.removeComposerAttachment(name);
});

Then('I should not see {string} as an attachment in the composer', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.composerAttachment(name)).toHaveCount(0, { timeout: 10_000 });
});

Then('I should see {string} as an attachment on my message', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.messageAttachment(name).first()).toBeVisible({ timeout: 10_000 });
});

Then(
  "I should see {string} as an attachment on the agent's message",
  async ({ page }, name: string) => {
    const homePage = new HomePage(page);
    // The file rides out on the final delivered message, so wait for the
    // stream to finish before asserting the chip is present.
    await homePage.waitForAgentResponse();
    await homePage.waitForStreamComplete();
    await expect(homePage.agentMessageAttachment(name).first()).toBeVisible({ timeout: 60_000 });
  },
);

Then(
  "I should not see {string} as an attachment on the agent's message",
  async ({ page }, name: string) => {
    const homePage = new HomePage(page);
    await homePage.waitForAgentResponse();
    await homePage.waitForStreamComplete();
    await expect(homePage.agentMessageAttachment(name)).toHaveCount(0);
  },
);

Then(
  "the agent's message should show an image between {string} and {string}",
  async ({ page }, before: string, after: string) => {
    const homePage = new HomePage(page);
    await homePage.waitForAgentResponse();
    await homePage.waitForStreamComplete();
    const message = homePage.getAgentMessages().last();
    const image = message.getByTestId('inline-image');
    await expect(image).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 10_000 })
      .toBe(true);
    const between = await message.evaluate((root, [first, last]) => {
      const textNode = (word: string) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes(word)) return node;
        }
        return null;
      };
      const img = root.querySelector('[data-testid="inline-image"]');
      const start = textNode(first);
      const end = textNode(last);
      if (!img || !start || !end) return false;
      const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return follows(start, img) && follows(img, end);
    }, [before, after]);
    expect(between, `the image sits between "${before}" and "${after}"`).toBe(true);
  },
);

Then('the agent response should contain {string}', async ({ page }, expected: string) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();
  await expect(homePage.getAgentMessages().last()).toContainText(expected, { timeout: 60_000 });
});

When('I wait for the agent to finish responding', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();
});

When('I reload the chat page', async ({ page }) => {
  await page.reload();
  await page.waitForLoadState('networkidle');
});

When('I download the attachment {string}', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  lastDownload = await homePage.downloadAttachment(name);
});

Then('the downloaded file should be named {string}', async ({}, name: string) => {
  expect(lastDownload, 'no download captured — call the download step first').toBeDefined();
  expect(lastDownload!.suggestedFilename()).toBe(name);
});

Then('the downloaded file should contain {string}', async ({}, expected: string) => {
  expect(lastDownload, 'no download captured — call the download step first').toBeDefined();
  const path = await lastDownload!.path();
  const content = await readFile(path, 'utf8');
  expect(content).toContain(expected);
});

// ---------------------------------------------------------------------------
// Helpers for constructing binary test fixtures in memory
// ---------------------------------------------------------------------------

/** Create a minimal valid ZIP archive containing a single text file. */
function createMinimalZip(innerFilename: string, innerContent: string): Buffer {
  const content = Buffer.from(innerContent, 'utf8');
  const compressed = deflateRawSync(content);
  const fnameBytes = Buffer.from(innerFilename, 'utf8');

  const now = new Date();
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const fileCrc = crc32(content) >>> 0;

  // Local file header
  const localHeader = Buffer.alloc(30 + fnameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed to extract
  localHeader.writeUInt16LE(0, 6); // general purpose bit flag
  localHeader.writeUInt16LE(8, 8); // compression method: deflate
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(fileCrc, 14);
  localHeader.writeUInt32LE(compressed.length, 18); // compressed size
  localHeader.writeUInt32LE(content.length, 22); // uncompressed size
  localHeader.writeUInt16LE(fnameBytes.length, 26); // file name length
  localHeader.writeUInt16LE(0, 28); // extra field length
  fnameBytes.copy(localHeader, 30);

  const localFileData = Buffer.concat([localHeader, compressed]);
  const centralDirOffset = localFileData.length;

  // Central directory header
  const centralHeader = Buffer.alloc(46 + fnameBytes.length);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8); // flags
  centralHeader.writeUInt16LE(8, 10); // compression: deflate
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(fileCrc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20); // compressed size
  centralHeader.writeUInt32LE(content.length, 24); // uncompressed size
  centralHeader.writeUInt16LE(fnameBytes.length, 28); // file name length
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // file comment length
  centralHeader.writeUInt16LE(0, 34); // disk number start
  centralHeader.writeUInt16LE(0, 36); // internal file attributes
  centralHeader.writeUInt32LE(0, 38); // external file attributes
  centralHeader.writeUInt32LE(0, 42); // relative offset of local header
  fnameBytes.copy(centralHeader, 46);

  const centralDirSize = centralHeader.length;

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central dir starts
  eocd.writeUInt16LE(1, 8); // number of entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localFileData, centralHeader, eocd]);
}

/** Create a minimal valid 1x1 red-pixel PNG image. */
function createMinimalPng(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: 1x1, 8-bit RGB
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  // IDAT: filter byte (0) + one RGB pixel (red). PNG uses zlib-wrapped deflate.
  const rawData = Buffer.from([0, 0xff, 0x00, 0x00]);
  const idat = pngChunk('IDAT', deflateSync(rawData));

  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([lengthBuf, typeBytes, data, crcBuf]);
}

// ---------------------------------------------------------------------------
// Step definitions for attachment tools (hydrate_attachment, view_attachment)
// ---------------------------------------------------------------------------

When(
  'I attach a zip file named {string} containing a file {string} with {string}',
  async ({ page }, zipName: string, innerName: string, innerContent: string) => {
    const homePage = new HomePage(page);
    const zipBuffer = createMinimalZip(innerName, innerContent);
    await homePage.attachFileBuffer({
      name: zipName,
      mimeType: 'application/zip',
      buffer: zipBuffer,
    });
    await expect(homePage.composerAttachment(zipName)).toBeVisible({ timeout: 10_000 });
  },
);

When('I attach a small PNG image named {string}', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  const pngBuffer = createMinimalPng();
  await homePage.attachFileBuffer({
    name,
    mimeType: 'image/png',
    buffer: pngBuffer,
  });
  await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
});

/**
 * Create a minimal single-page PDF whose page shows `text` in Helvetica.
 * All content is ASCII, so string length == byte offset for the xref table.
 */
function createMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 24 Tf 72 700 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

When(
  'I attach a small PDF named {string} containing the text {string}',
  async ({ page }, name: string, text: string) => {
    const homePage = new HomePage(page);
    await homePage.attachFileBuffer({
      name,
      mimeType: 'application/pdf',
      buffer: createMinimalPdf(text),
    });
    await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
  },
);

// ---------------------------------------------------------------------------
// Expired-content (retention sweep) steps
// ---------------------------------------------------------------------------

When(
  'the content of the attachment {string} is expired by the retention sweep',
  async ({}, filename: string) => {
    lastExpiredAttachmentId = await expireAttachmentContent(filename);
  },
);

Then(
  'the attachment {string} on my message should be marked expired',
  async ({ page }, filename: string) => {
    const homePage = new HomePage(page);
    const chip = homePage.messageAttachment(filename).first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText('Expired');
  },
);

Then(
  'requesting the attachment {string} over HTTP should answer 410',
  async ({ page }, filename: string) => {
    expect(
      lastExpiredAttachmentId,
      `no expired attachment id captured for ${filename} — run the expire step first`,
    ).toBeDefined();
    const res = await page.request.get(
      `http://localhost:3003/agents/attachments/${lastExpiredAttachmentId}`,
    );
    expect(res.status()).toBe(410);
  },
);
