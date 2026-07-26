/**
 * Tests for the pure parts of src/tools/screenshots.ts.
 *
 * Kept outside `src/` so `tsc` (which compiles src -> dist) ignores it.
 *
 * Run with:  npx tsx --test test/screenshots.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readImageDimensions,
  validateScreenshotDimensions,
  screenshotTools,
} from '../src/tools/screenshots.js';

/** Build the smallest buffer whose PNG header advertises the given size. */
function fakePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** Build a JPEG with one APP0 segment followed by an SOF0 frame header. */
function fakeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]); // length 4 => 2 payload bytes
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(9, 2); // segment length
  sof0.writeUInt8(8, 4); // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.alloc(16), // padding so the parser's lookahead window is satisfied
  ]);
}

test('reads PNG dimensions from the IHDR header', () => {
  assert.deepEqual(readImageDimensions(fakePng(1290, 2796)), {
    width: 1290,
    height: 2796,
    format: 'png',
  });
});

test('reads JPEG dimensions from the SOF0 frame header', () => {
  assert.deepEqual(readImageDimensions(fakeJpeg(750, 1334)), {
    width: 750,
    height: 1334,
    format: 'jpeg',
  });
});

test('returns null for a file that is neither PNG nor JPEG', () => {
  assert.equal(readImageDimensions(Buffer.from('not an image at all, really')), null);
});

test('accepts the exact portrait dimensions of a display type', () => {
  assert.equal(
    validateScreenshotDimensions(fakePng(1290, 2796), 'APP_IPHONE_67', 'shot.png').ok,
    true
  );
});

test('accepts the landscape variant (dimensions swapped)', () => {
  assert.equal(
    validateScreenshotDimensions(fakePng(2796, 1290), 'APP_IPHONE_67', 'shot.png').ok,
    true
  );
});

test('accepts every alternative size Apple allows for one display type', () => {
  assert.equal(
    validateScreenshotDimensions(fakePng(1320, 2868), 'APP_IPHONE_67', 'shot.png').ok,
    true
  );
});

test('rejects a wrong size with an actionable message', () => {
  const check = validateScreenshotDimensions(fakePng(1242, 2688), 'APP_IPHONE_67', 'shot.png');
  assert.equal(check.ok, false);
  assert.match(check.reason!, /1242x2688/);
  assert.match(check.reason!, /APP_IPHONE_67/);
  assert.match(check.reason!, /1290x2796/);
});

test('rejects a non-image file before it ever reaches Apple', () => {
  const check = validateScreenshotDimensions(
    Buffer.from('%PDF-1.4 nope'),
    'APP_IPHONE_67',
    'shot.pdf'
  );
  assert.equal(check.ok, false);
  assert.match(check.reason!, /PNG or JPEG/);
});

test('lets an unknown (newer) display type through for Apple to arbitrate', () => {
  assert.equal(
    validateScreenshotDimensions(fakePng(1, 1), 'APP_IPHONE_FUTURE_99', 'shot.png').ok,
    true
  );
});

test('every exported tool is well formed and uniquely named', () => {
  const names = new Set<string>();

  for (const tool of screenshotTools) {
    assert.match(tool.name, /^[a-z0-9_]+$/, `${tool.name} must be snake_case`);
    assert.equal(names.has(tool.name), false, `duplicate tool name: ${tool.name}`);
    names.add(tool.name);

    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal((tool.inputSchema as any).type, 'object', `${tool.name} schema must be an object`);
    assert.equal(typeof tool.handler, 'function');
  }

  assert.equal(names.size, screenshotTools.length);
});
