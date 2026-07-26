/**
 * Tools for App Store screenshots and app previews (media assets).
 *
 * Apple never accepts a raw file on a JSON endpoint. Every media asset goes
 * through the same three-step dance:
 *
 *   1. RESERVE  POST /v1/appScreenshots  { fileSize, fileName, relationships }
 *               -> Apple answers with `uploadOperations`, a list of chunk
 *                  descriptors: { method, url, length, offset, requestHeaders }.
 *   2. UPLOAD   For each operation, PUT the matching slice of the file to the
 *               given (pre-signed, usually S3) URL with the supplied headers.
 *               These URLs already carry their own signature: sending Apple's
 *               `Authorization` header there makes AWS reject the request, so
 *               the raw `fetch` below is deliberate — do NOT route it through
 *               AppStoreClient.
 *   3. COMMIT   PATCH /v1/appScreenshots/{id} { uploaded: true,
 *                                               sourceFileChecksum: <md5 hex> }
 *               The checksum covers the WHOLE file, not a chunk.
 *
 * After the commit, Apple processes the asset asynchronously. The real outcome
 * lives in `attributes.assetDeliveryState.state`
 * (UPLOAD_COMPLETE -> COMPLETE, or FAILED with `errors`), which is why every
 * upload tool polls before reporting success.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { defineTool, type Tool } from './types.js';
import type { AppStoreClient } from '../appstore-client.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Apple enums and the exact pixel dimensions they demand
// ---------------------------------------------------------------------------

/**
 * Accepted portrait dimensions per `screenshotDisplayType`, in pixels.
 * The landscape variant (width/height swapped) is accepted as well, so the
 * validator tries both orientations.
 *
 * A display type absent from this table is still allowed through — Apple keeps
 * adding devices, and refusing an unknown-but-valid type would be worse than
 * letting Apple arbitrate.
 */
const SCREENSHOT_DIMENSIONS: Record<string, Array<[number, number]>> = {
  // iPhone
  APP_IPHONE_67: [
    [1290, 2796],
    [1320, 2868],
  ],
  APP_IPHONE_65: [
    [1242, 2688],
    [1284, 2778],
  ],
  APP_IPHONE_61: [
    [1170, 2532],
    [1179, 2556],
    [1206, 2622],
  ],
  APP_IPHONE_58: [
    [1125, 2436],
    [1080, 2340],
  ],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPHONE_47: [[750, 1334]],
  APP_IPHONE_40: [
    [640, 1096],
    [640, 1136],
  ],
  APP_IPHONE_35: [
    [640, 920],
    [640, 960],
  ],
  // iPad
  // 2064x2752 is the iPad 13" (M4) size Apple started returning in 2024. It was
  // missing here, and the validator rejected screenshots that are live on the
  // store right now — verified against 87 published APP_IPAD_PRO_3GEN_129 assets
  // whose imageAsset reads 2064x2752 with assetDeliveryState COMPLETE.
  APP_IPAD_PRO_3GEN_129: [
    [2048, 2732],
    [2064, 2752],
  ],
  APP_IPAD_PRO_3GEN_11: [
    [1668, 2388],
    [1640, 2360],
    [1488, 2266],
  ],
  APP_IPAD_PRO_129: [
    [2048, 2732],
    [2064, 2752],
  ],
  APP_IPAD_105: [[1668, 2224]],
  APP_IPAD_97: [
    [1536, 2048],
    [768, 1024],
  ],
  // Mac / TV / Vision
  APP_DESKTOP: [
    [1280, 800],
    [1440, 900],
    [2560, 1600],
    [2880, 1800],
  ],
  APP_APPLE_TV: [
    [1920, 1080],
    [3840, 2160],
  ],
  APP_APPLE_VISION_PRO: [[3840, 2160]],
  // Watch
  APP_WATCH_ULTRA: [[410, 502]],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_3: [[312, 390]],
};

/** Every value Apple accepts for `screenshotDisplayType`. */
const SCREENSHOT_DISPLAY_TYPES = [
  'APP_IPHONE_67',
  'APP_IPHONE_65',
  'APP_IPHONE_61',
  'APP_IPHONE_58',
  'APP_IPHONE_55',
  'APP_IPHONE_47',
  'APP_IPHONE_40',
  'APP_IPHONE_35',
  'APP_IPAD_PRO_3GEN_129',
  'APP_IPAD_PRO_3GEN_11',
  'APP_IPAD_PRO_129',
  'APP_IPAD_105',
  'APP_IPAD_97',
  'APP_DESKTOP',
  'APP_APPLE_TV',
  'APP_APPLE_VISION_PRO',
  'APP_WATCH_ULTRA',
  'APP_WATCH_SERIES_10',
  'APP_WATCH_SERIES_7',
  'APP_WATCH_SERIES_4',
  'APP_WATCH_SERIES_3',
  'IMESSAGE_APP_IPHONE_67',
  'IMESSAGE_APP_IPHONE_65',
  'IMESSAGE_APP_IPHONE_61',
  'IMESSAGE_APP_IPHONE_58',
  'IMESSAGE_APP_IPHONE_55',
  'IMESSAGE_APP_IPHONE_47',
  'IMESSAGE_APP_IPHONE_40',
  'IMESSAGE_APP_IPAD_PRO_3GEN_129',
  'IMESSAGE_APP_IPAD_PRO_3GEN_11',
  'IMESSAGE_APP_IPAD_PRO_129',
  'IMESSAGE_APP_IPAD_105',
  'IMESSAGE_APP_IPAD_97',
];

/** Every value Apple accepts for `previewType` on an appPreviewSet. */
const PREVIEW_TYPES = [
  'IPHONE_67',
  'IPHONE_65',
  'IPHONE_61',
  'IPHONE_58',
  'IPHONE_55',
  'IPHONE_47',
  'IPHONE_40',
  'IPHONE_35',
  'IPAD_PRO_3GEN_129',
  'IPAD_PRO_3GEN_11',
  'IPAD_PRO_129',
  'IPAD_105',
  'IPAD_97',
  'DESKTOP',
  'APPLE_TV',
  'APPLE_VISION_PRO',
  'WATCH_ULTRA',
  'WATCH_SERIES_10',
  'WATCH_SERIES_7',
  'WATCH_SERIES_4',
  'WATCH_SERIES_3',
];

const DISPLAY_TYPE_DOC = `One of: ${SCREENSHOT_DISPLAY_TYPES.join(', ')}`;
const PREVIEW_TYPE_DOC = `One of: ${PREVIEW_TYPES.join(', ')}`;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

// ---------------------------------------------------------------------------
// Image introspection — no external dependency
// ---------------------------------------------------------------------------

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
}

/**
 * Read the pixel dimensions straight out of the file header.
 *
 * PNG: the IHDR chunk always starts at byte 8, width/height are the two
 * big-endian uint32 at offsets 16 and 20.
 * JPEG: walk the marker chain until a SOFn frame header, whose payload holds
 * height then width as big-endian uint16.
 *
 * Returns `null` for anything that is not a PNG or JPEG rather than throwing —
 * the caller decides whether an unreadable header is fatal.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  // --- PNG ---
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      format: 'png',
    };
  }

  // --- JPEG ---
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;

    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1; // Resynchronise on padding bytes between segments.
        continue;
      }

      const marker = buffer[offset + 1];

      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      // Start of scan: pixel data begins, no frame header will follow.
      if (marker === 0xda) break;

      const segmentLength = buffer.readUInt16BE(offset + 2);

      // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

      if (isFrameHeader) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
          format: 'jpeg',
        };
      }

      offset += 2 + segmentLength;
    }
  }

  return null;
}

export interface DimensionCheck {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  dimensions?: ImageDimensions;
}

/**
 * Validate a file's dimensions against what Apple expects for a display type.
 *
 * Both orientations are accepted: a landscape screenshot is the portrait pair
 * with width and height swapped.
 */
export function validateScreenshotDimensions(
  buffer: Buffer,
  displayType: string,
  fileName: string
): DimensionCheck {
  const expected = SCREENSHOT_DIMENSIONS[displayType];
  if (!expected) {
    // Unknown (probably newer) display type: let Apple be the judge.
    return { ok: true };
  }

  const dimensions = readImageDimensions(buffer);
  if (!dimensions) {
    return {
      ok: false,
      reason: `${fileName}: not a readable PNG or JPEG (App Store screenshots must be PNG or JPEG).`,
    };
  }

  const { width, height } = dimensions;
  const matches = expected.some(
    ([w, h]) => (width === w && height === h) || (width === h && height === w)
  );

  if (matches) return { ok: true, dimensions };

  const allowed = expected
    .map(([w, h]) => `${w}x${h} (portrait) or ${h}x${w} (landscape)`)
    .join(', ');

  return {
    ok: false,
    dimensions,
    reason: `${fileName}: ${width}x${height} px is not valid for ${displayType}. Apple accepts ${allowed}.`,
  };
}

// ---------------------------------------------------------------------------
// The three-step upload flow
// ---------------------------------------------------------------------------

interface UploadOperation {
  method?: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: Array<{ name: string; value: string }>;
}

interface AssetDeliveryState {
  state?: string;
  errors?: Array<{ code?: string; description?: string }>;
  warnings?: Array<{ code?: string; description?: string }>;
}

/**
 * Step 2: push every chunk to its pre-signed URL.
 *
 * Chunks are independent, so they go out in parallel. `fetch` is used raw on
 * purpose: these URLs are already signed and adding Apple's bearer token would
 * make the storage backend reject the PUT.
 */
async function executeUploadOperations(operations: UploadOperation[], buffer: Buffer): Promise<void> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(
      'Apple returned no uploadOperations for this asset. The reservation is unusable; delete it and retry.'
    );
  }

  await Promise.all(
    operations.map(async (operation, index) => {
      const chunk = buffer.subarray(operation.offset, operation.offset + operation.length);

      const headers: Record<string, string> = {};
      for (const header of operation.requestHeaders ?? []) {
        headers[header.name] = header.value;
      }

      logger.debug(
        `Uploading chunk ${index + 1}/${operations.length} (offset ${operation.offset}, ${operation.length} bytes)`
      );

      const response = await fetch(operation.url, {
        method: operation.method || 'PUT',
        headers,
        // A copy is needed: `subarray` shares the parent ArrayBuffer, whose
        // byteOffset the fetch body would otherwise ignore.
        body: new Uint8Array(chunk),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Chunk ${index + 1}/${operations.length} failed with HTTP ${response.status} ${response.statusText}. ${body.slice(0, 300)}`
        );
      }
    })
  );
}

/** MD5 of the whole file, hex encoded — what `sourceFileChecksum` expects. */
function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * Poll an asset until Apple finishes processing it.
 *
 * COMPLETE means the asset is live. FAILED carries actionable messages in
 * `assetDeliveryState.errors`. Anything else (UPLOAD_COMPLETE, AWAITING_UPLOAD)
 * is still in flight.
 */
async function pollAssetDeliveryState(
  client: AppStoreClient,
  resourcePath: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<AssetDeliveryState> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  let last: AssetDeliveryState = {};

  while (Date.now() < deadline) {
    const response = await client.get(resourcePath);
    last = (response?.data?.attributes?.assetDeliveryState ?? {}) as AssetDeliveryState;

    if (last.state === 'COMPLETE' || last.state === 'FAILED') return last;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return last;
}

/**
 * Count how many assets in a collection are not live.
 *
 * A bare "6 screenshot(s)" is misleading when some of them failed processing:
 * they exist as resources but will never show on the store. Listing tools append
 * this so the count cannot be read as "6 published".
 */
function summarizeAssetHealth(assets: any[]): string {
  const notComplete = assets.filter(
    (asset) => (asset.attributes?.assetDeliveryState?.state ?? 'UNKNOWN') !== 'COMPLETE'
  );

  if (notComplete.length === 0) return '';

  const byState = new Map<string, number>();
  for (const asset of notComplete) {
    const state = asset.attributes?.assetDeliveryState?.state ?? 'UNKNOWN';
    byState.set(state, (byState.get(state) ?? 0) + 1);
  }

  return ` ⚠️ ${[...byState].map(([state, n]) => `${n} ${state}`).join(', ')}`;
}

function describeAssetState(state: AssetDeliveryState): string {
  const parts = [`state: ${state.state ?? 'UNKNOWN'}`];

  if (state.errors?.length) {
    parts.push(
      `errors: ${state.errors.map((e) => e.description || e.code || 'unknown').join(' | ')}`
    );
  }
  if (state.warnings?.length) {
    parts.push(
      `warnings: ${state.warnings.map((w) => w.description || w.code || 'unknown').join(' | ')}`
    );
  }

  return parts.join(', ');
}

interface UploadedAsset {
  id: string;
  fileName: string;
  state: AssetDeliveryState;
}

/** Reserve + upload + commit + poll for one screenshot file. */
async function uploadScreenshotFile(
  client: AppStoreClient,
  params: { setId: string; filePath: string; buffer: Buffer; fileName: string; wait: boolean }
): Promise<UploadedAsset> {
  // 1. Reserve.
  const reservation = await client.post('/v1/appScreenshots', {
    data: {
      type: 'appScreenshots',
      attributes: {
        fileSize: params.buffer.length,
        fileName: params.fileName,
      },
      relationships: {
        appScreenshotSet: { data: { type: 'appScreenshotSets', id: params.setId } },
      },
    },
  });

  const screenshotId: string = reservation.data.id;

  try {
    // 2. Upload every chunk.
    await executeUploadOperations(
      reservation.data.attributes?.uploadOperations ?? [],
      params.buffer
    );

    // 3. Commit with the checksum of the whole file.
    await client.patch(`/v1/appScreenshots/${screenshotId}`, {
      data: {
        type: 'appScreenshots',
        id: screenshotId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: md5Hex(params.buffer),
        },
      },
    });
  } catch (error) {
    // A reservation without a successful upload is a ghost row in App Store
    // Connect. Clean it up so a retry starts from a sane state.
    await client
      .delete(`/v1/appScreenshots/${screenshotId}`)
      .catch(() => logger.warn(`Could not clean up incomplete screenshot ${screenshotId}.`));
    throw error;
  }

  const state = params.wait
    ? await pollAssetDeliveryState(client, `/v1/appScreenshots/${screenshotId}`)
    : { state: 'UPLOAD_COMPLETE' };

  return { id: screenshotId, fileName: params.fileName, state };
}

/** Reserve + upload + commit + poll for one app preview (video) file. */
async function uploadPreviewFile(
  client: AppStoreClient,
  params: {
    setId: string;
    buffer: Buffer;
    fileName: string;
    mimeType?: string;
    previewFrameTimeCode?: string;
    wait: boolean;
  }
): Promise<UploadedAsset> {
  const attributes: Record<string, unknown> = {
    fileSize: params.buffer.length,
    fileName: params.fileName,
  };
  if (params.mimeType) attributes.mimeType = params.mimeType;
  if (params.previewFrameTimeCode) attributes.previewFrameTimeCode = params.previewFrameTimeCode;

  const reservation = await client.post('/v1/appPreviews', {
    data: {
      type: 'appPreviews',
      attributes,
      relationships: {
        appPreviewSet: { data: { type: 'appPreviewSets', id: params.setId } },
      },
    },
  });

  const previewId: string = reservation.data.id;

  try {
    await executeUploadOperations(reservation.data.attributes?.uploadOperations ?? [], params.buffer);

    await client.patch(`/v1/appPreviews/${previewId}`, {
      data: {
        type: 'appPreviews',
        id: previewId,
        attributes: {
          uploaded: true,
          sourceFileChecksum: md5Hex(params.buffer),
        },
      },
    });
  } catch (error) {
    await client
      .delete(`/v1/appPreviews/${previewId}`)
      .catch(() => logger.warn(`Could not clean up incomplete preview ${previewId}.`));
    throw error;
  }

  const state = params.wait
    ? // Video transcoding is slow; give Apple more room than for a still.
      await pollAssetDeliveryState(client, `/v1/appPreviews/${previewId}`, { timeoutMs: 300_000 })
    : { state: 'UPLOAD_COMPLETE' };

  return { id: previewId, fileName: params.fileName, state };
}

// ---------------------------------------------------------------------------
// Resource resolution helpers
// ---------------------------------------------------------------------------

/** Find a version localization by locale, or explain which locales do exist. */
async function resolveLocalization(
  client: AppStoreClient,
  versionId: string,
  locale: string
): Promise<{ id: string; locale: string }> {
  const { data } = await client.getAllPages(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`
  );

  const match = data.find((loc: any) => loc.attributes?.locale === locale);
  if (match) return { id: match.id, locale };

  const available = data.map((loc: any) => loc.attributes?.locale).join(', ') || 'none';
  throw new Error(
    `No "${locale}" localization on version ${versionId}. Existing locales: ${available}. ` +
      'Create it first with localizations_create (or update_app_store_version_localization, ' +
      'which creates the locale when it is missing).'
  );
}

/** Find the screenshot set for a display type, creating it when absent. */
async function resolveScreenshotSet(
  client: AppStoreClient,
  localizationId: string,
  displayType: string
): Promise<{ id: string; created: boolean }> {
  const { data } = await client.getAllPages(
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`
  );

  const match = data.find((set: any) => set.attributes?.screenshotDisplayType === displayType);
  if (match) return { id: match.id, created: false };

  const created = await client.post('/v1/appScreenshotSets', {
    data: {
      type: 'appScreenshotSets',
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: 'appStoreVersionLocalizations', id: localizationId },
        },
      },
    },
  });

  return { id: created.data.id, created: true };
}

/** Find the preview set for a preview type, creating it when absent. */
async function resolvePreviewSet(
  client: AppStoreClient,
  localizationId: string,
  previewType: string
): Promise<{ id: string; created: boolean }> {
  const { data } = await client.getAllPages(
    `/v1/appStoreVersionLocalizations/${localizationId}/appPreviewSets`
  );

  const match = data.find((set: any) => set.attributes?.previewType === previewType);
  if (match) return { id: match.id, created: false };

  const created = await client.post('/v1/appPreviewSets', {
    data: {
      type: 'appPreviewSets',
      attributes: { previewType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: 'appStoreVersionLocalizations', id: localizationId },
        },
      },
    },
  });

  return { id: created.data.id, created: true };
}

/** Remove every screenshot currently attached to a set. */
async function clearScreenshotSet(client: AppStoreClient, setId: string): Promise<number> {
  const { data } = await client.getAllPages(`/v1/appScreenshotSets/${setId}/appScreenshots`);

  for (const screenshot of data as any[]) {
    await client.delete(`/v1/appScreenshots/${screenshot.id}`);
  }

  return data.length;
}

// ---------------------------------------------------------------------------
// Batch input resolution (directory convention / explicit mapping)
// ---------------------------------------------------------------------------

interface BatchEntry {
  locale: string;
  displayType: string;
  files: string[];
}

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Walk `<directory>/<locale>/...` and turn it into batch entries.
 *
 * Two layouts are supported:
 *   <root>/<locale>/<DISPLAY_TYPE>/*.png   — display type per sub-folder
 *   <root>/<locale>/*.png                  — needs `defaultDisplayType`
 *
 * Files are sorted by name, which becomes the on-store ordering.
 */
async function scanLocaleDirectory(
  directory: string,
  defaultDisplayType?: string
): Promise<BatchEntry[]> {
  const entries: BatchEntry[] = [];
  const localeDirs = await readdir(directory, { withFileTypes: true });

  for (const localeDir of localeDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!localeDir.isDirectory() || localeDir.name.startsWith('.')) continue;

    const localePath = join(directory, localeDir.name);
    const children = await readdir(localePath, { withFileTypes: true });

    const subDirs = children.filter((c) => c.isDirectory() && !c.name.startsWith('.'));
    const images = children
      .filter((c) => c.isFile() && isImageFile(c.name))
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b));

    if (subDirs.length > 0) {
      for (const subDir of subDirs.sort((a, b) => a.name.localeCompare(b.name))) {
        const setPath = join(localePath, subDir.name);
        const setFiles = (await readdir(setPath))
          .filter(isImageFile)
          .sort((a, b) => a.localeCompare(b))
          .map((name) => join(setPath, name));

        if (setFiles.length === 0) continue;

        entries.push({
          locale: localeDir.name,
          // The folder name IS the display type in this layout.
          displayType: subDir.name.toUpperCase(),
          files: setFiles,
        });
      }
      continue;
    }

    if (images.length === 0) continue;

    if (!defaultDisplayType) {
      throw new Error(
        `"${localePath}" holds images directly, so a displayType is required. ` +
          'Either pass `displayType`, or nest the files in a folder named after the display type ' +
          '(e.g. <locale>/APP_IPHONE_67/01.png).'
      );
    }

    entries.push({
      locale: localeDir.name,
      displayType: defaultDisplayType,
      files: images.map((name) => join(localePath, name)),
    });
  }

  if (entries.length === 0) {
    throw new Error(
      `No screenshots found under "${directory}". Expected <directory>/<locale>/[<DISPLAY_TYPE>/]*.png`
    );
  }

  return entries;
}

/** Load a file and fail with a path-qualified message when it is missing. */
async function loadFile(filePath: string): Promise<{ buffer: Buffer; fileName: string }> {
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }

  return { buffer: await readFile(filePath), fileName: basename(filePath) };
}

// ---------------------------------------------------------------------------
// Tools — listing
// ---------------------------------------------------------------------------

export const listScreenshotSets = defineTool<{ localizationId: string }>({
  name: 'screenshots_list_sets',
  description:
    'List the screenshot sets (one per device display type) of an app store version localization',
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the appStoreVersionLocalization',
      },
    },
    required: ['localizationId'],
  },
  handler: async ({ localizationId }, client) => {
    const { data } = await client.getAllPages(
      `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`
    );

    if (data.length === 0) {
      return `No screenshot sets on localization ${localizationId}.`;
    }

    const lines = await Promise.all(
      (data as any[]).map(async (set) => {
        const shots = await client.getAllPages(`/v1/appScreenshotSets/${set.id}/appScreenshots`);
        return `• ${set.attributes?.screenshotDisplayType ?? '(unknown display type)'} — ${
          shots.data.length
        } screenshot(s)${summarizeAssetHealth(shots.data)} — set ID: ${set.id}`;
      })
    );

    // Apple returns sets in insertion order, which differs per locale; sorting
    // keeps two calls comparable.
    lines.sort((a, b) => a.localeCompare(b));

    return `🖼️ Screenshot sets for localization ${localizationId}:\n\n${lines.join('\n')}`;
  },
});

export const listScreenshots = defineTool<{ setId: string }>({
  name: 'screenshots_list',
  description:
    'List the screenshots of a screenshot set, in display order, with their asset delivery state',
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The ID of the appScreenshotSet' },
    },
    required: ['setId'],
  },
  handler: async ({ setId }, client) => {
    const { data } = await client.getAllPages(`/v1/appScreenshotSets/${setId}/appScreenshots`);

    if (data.length === 0) return `Screenshot set ${setId} is empty.`;

    const lines = (data as any[]).map((shot, index) => {
      const attributes = shot.attributes ?? {};
      const size = attributes.imageAsset
        ? `${attributes.imageAsset.width}x${attributes.imageAsset.height}`
        : 'unknown size';

      return `${index + 1}. ${attributes.fileName ?? '(no name)'} — ${size} — ${describeAssetState(
        attributes.assetDeliveryState ?? {}
      )} — ID: ${shot.id}`;
    });

    return `🖼️ ${data.length} screenshot(s) in set ${setId}:\n\n${lines.join('\n')}`;
  },
});

export const listVersionScreenshotOverview = defineTool<{ versionId: string }>({
  name: 'screenshots_version_overview',
  description:
    'Show every locale of an app store version with its screenshot sets and screenshot counts',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the appStoreVersion' },
    },
    required: ['versionId'],
  },
  handler: async ({ versionId }, client) => {
    const { data: localizations } = await client.getAllPages(
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`
    );

    if (localizations.length === 0) return `No localizations on version ${versionId}.`;

    let total = 0;
    let localesWithout = 0;

    const blocks = await Promise.all(
      (localizations as any[]).map(async (localization) => {
        const locale = localization.attributes?.locale ?? '(unknown locale)';
        const { data: sets } = await client.getAllPages(
          `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`
        );

        if (sets.length === 0) {
          localesWithout += 1;
          return { locale, text: `${locale} (${localization.id})\n   • no screenshot set` };
        }

        const setLines = await Promise.all(
          (sets as any[]).map(async (set) => {
            const shots = await client.getAllPages(`/v1/appScreenshotSets/${set.id}/appScreenshots`);
            total += shots.data.length;
            return `   • ${set.attributes?.screenshotDisplayType ?? '(unknown display type)'}: ${
              shots.data.length
            } screenshot(s)${summarizeAssetHealth(shots.data)} — set ${set.id}`;
          })
        );

        setLines.sort((a, b) => a.localeCompare(b));

        return { locale, text: `${locale} (${localization.id})\n${setLines.join('\n')}` };
      })
    );

    // Apple's locale ordering is arbitrary and not stable between calls.
    blocks.sort((a, b) => a.locale.localeCompare(b.locale));

    const footer = `${localizations.length} locale(s), ${total} screenshot(s) total${
      localesWithout > 0 ? `, ${localesWithout} locale(s) with no screenshot at all` : ''
    }.`;

    return `🌍 Screenshots for version ${versionId}:\n\n${blocks
      .map((b) => b.text)
      .join('\n\n')}\n\n${footer}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — set management
// ---------------------------------------------------------------------------

export const createScreenshotSet = defineTool<{ localizationId: string; displayType: string }>({
  name: 'screenshots_create_set',
  description: 'Create a screenshot set for a display type on an app store version localization',
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the appStoreVersionLocalization',
      },
      displayType: {
        type: 'string',
        description: `Apple screenshotDisplayType. ${DISPLAY_TYPE_DOC}`,
        enum: SCREENSHOT_DISPLAY_TYPES,
      },
    },
    required: ['localizationId', 'displayType'],
  },
  handler: async ({ localizationId, displayType }, client) => {
    const set = await resolveScreenshotSet(client, localizationId, displayType);

    return set.created
      ? `✅ Screenshot set created for ${displayType} — set ID: ${set.id}`
      : `ℹ️ A ${displayType} set already existed on this localization — set ID: ${set.id}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — single upload
// ---------------------------------------------------------------------------

export const uploadScreenshot = defineTool<{
  filePath: string;
  setId?: string;
  localizationId?: string;
  displayType?: string;
  skipDimensionCheck?: boolean;
  wait?: boolean;
}>({
  name: 'screenshots_upload',
  description:
    'Upload one screenshot from a local file to a screenshot set (reserve, chunked upload, commit, then report the asset delivery state)',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the PNG or JPEG file to upload',
      },
      setId: {
        type: 'string',
        description:
          'Target appScreenshotSet ID. Omit it and pass localizationId + displayType to reuse or create the set automatically.',
      },
      localizationId: {
        type: 'string',
        description: 'The appStoreVersionLocalization ID (used when setId is not given)',
      },
      displayType: {
        type: 'string',
        description: `Apple screenshotDisplayType, required when setId is not given, and used to validate the image dimensions. ${DISPLAY_TYPE_DOC}`,
        enum: SCREENSHOT_DISPLAY_TYPES,
      },
      skipDimensionCheck: {
        type: 'boolean',
        description: 'Skip local dimension validation and let Apple reject the file (default false)',
      },
      wait: {
        type: 'boolean',
        description: 'Poll until Apple finishes processing the asset (default true)',
      },
    },
    required: ['filePath'],
  },
  handler: async (args, client) => {
    const { buffer, fileName } = await loadFile(args.filePath);

    let setId = args.setId;
    let displayType = args.displayType;
    let setNote = '';

    if (!setId) {
      if (!args.localizationId || !displayType) {
        throw new Error('Provide either `setId`, or both `localizationId` and `displayType`.');
      }
      const set = await resolveScreenshotSet(client, args.localizationId, displayType);
      setId = set.id;
      setNote = set.created ? ' (set created)' : '';
    } else if (!displayType) {
      // Fetch the set so dimensions can still be validated.
      const response = await client.get(`/v1/appScreenshotSets/${setId}`);
      displayType = response?.data?.attributes?.screenshotDisplayType;
    }

    if (!args.skipDimensionCheck && displayType) {
      const check = validateScreenshotDimensions(buffer, displayType, fileName);
      if (!check.ok) {
        throw new Error(`${check.reason} Pass skipDimensionCheck=true to upload anyway.`);
      }
    }

    const asset = await uploadScreenshotFile(client, {
      setId,
      filePath: args.filePath,
      buffer,
      fileName,
      wait: args.wait !== false,
    });

    const dimensions = readImageDimensions(buffer);
    const failed = asset.state.state === 'FAILED';

    return `${failed ? '❌' : '✅'} Screenshot ${failed ? 'rejected' : 'uploaded'}: ${fileName}${setNote}
• Set: ${displayType ?? 'unknown display type'} (${setId})
• Size: ${(buffer.length / 1024).toFixed(0)} KB${dimensions ? `, ${dimensions.width}x${dimensions.height} px` : ''}
• Checksum (MD5): ${md5Hex(buffer)}
• Screenshot ID: ${asset.id}
• Delivery: ${describeAssetState(asset.state)}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — multi-locale batch upload
// ---------------------------------------------------------------------------

export const uploadScreenshotsBatch = defineTool<{
  versionId: string;
  directory?: string;
  entries?: Array<{ locale: string; displayType?: string; files: string[] }>;
  displayType?: string;
  replaceExisting?: boolean;
  skipDimensionCheck?: boolean;
  wait?: boolean;
}>({
  name: 'screenshots_upload_batch',
  description:
    'Upload screenshots for several locales at once, from a directory tree (<dir>/<locale>/[<DISPLAY_TYPE>/]*.png) or an explicit locale-to-files mapping',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: {
        type: 'string',
        description: 'The appStoreVersion ID whose localizations receive the screenshots',
      },
      directory: {
        type: 'string',
        description:
          'Absolute path to a folder laid out as <directory>/<locale>/<DISPLAY_TYPE>/*.png, or <directory>/<locale>/*.png when `displayType` is also given. Files are uploaded in filename order.',
      },
      entries: {
        type: 'array',
        description: 'Explicit mapping, used instead of `directory`',
        items: {
          type: 'object',
          properties: {
            locale: { type: 'string', description: 'Locale code, e.g. "en-US", "fr-FR"' },
            displayType: {
              type: 'string',
              description: `Display type for this entry, defaults to the top-level displayType. ${DISPLAY_TYPE_DOC}`,
              enum: SCREENSHOT_DISPLAY_TYPES,
            },
            files: {
              type: 'array',
              description: 'Absolute paths, in the order the screenshots must appear',
              items: { type: 'string' },
            },
          },
          required: ['locale', 'files'],
        },
      },
      displayType: {
        type: 'string',
        description: `Default display type applied to entries that do not set one. ${DISPLAY_TYPE_DOC}`,
        enum: SCREENSHOT_DISPLAY_TYPES,
      },
      replaceExisting: {
        type: 'boolean',
        description: 'Delete the screenshots already in each target set before uploading (default false)',
      },
      skipDimensionCheck: {
        type: 'boolean',
        description: 'Skip local dimension validation (default false)',
      },
      wait: {
        type: 'boolean',
        description: 'Poll each asset until Apple finishes processing (default true)',
      },
    },
    required: ['versionId'],
  },
  handler: async (args, client) => {
    // --- Resolve the work list -------------------------------------------------
    let entries: BatchEntry[];

    if (args.directory) {
      entries = await scanLocaleDirectory(args.directory, args.displayType);
    } else if (args.entries?.length) {
      entries = args.entries.map((entry) => {
        const displayType = entry.displayType ?? args.displayType;
        if (!displayType) {
          throw new Error(
            `Entry for locale "${entry.locale}" has no displayType and no top-level displayType was given.`
          );
        }
        return { locale: entry.locale, displayType, files: entry.files };
      });
    } else {
      throw new Error('Provide either `directory` or a non-empty `entries` array.');
    }

    // --- Validate everything BEFORE touching Apple -----------------------------
    // A batch that dies halfway leaves the store in a half-updated state, so all
    // files are read and checked up front.
    const loaded = new Map<string, { buffer: Buffer; fileName: string }>();
    const problems: string[] = [];

    for (const entry of entries) {
      if (!SCREENSHOT_DISPLAY_TYPES.includes(entry.displayType)) {
        problems.push(
          `${entry.locale}: "${entry.displayType}" is not a valid screenshotDisplayType. ${DISPLAY_TYPE_DOC}`
        );
        continue;
      }

      for (const filePath of entry.files) {
        try {
          const file = await loadFile(filePath);
          loaded.set(filePath, file);

          if (!args.skipDimensionCheck) {
            const check = validateScreenshotDimensions(file.buffer, entry.displayType, filePath);
            if (!check.ok) problems.push(`${entry.locale}: ${check.reason}`);
          }
        } catch (error: any) {
          problems.push(`${entry.locale}: ${error?.message ?? String(error)}`);
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Batch aborted, nothing was uploaded. ${problems.length} problem(s):\n• ${problems.join('\n• ')}`
      );
    }

    // --- Upload ---------------------------------------------------------------
    const report: string[] = [];
    let uploadedCount = 0;
    let failedCount = 0;

    for (const entry of entries) {
      const localization = await resolveLocalization(client, args.versionId, entry.locale);
      const set = await resolveScreenshotSet(client, localization.id, entry.displayType);

      let removed = 0;
      if (args.replaceExisting) {
        removed = await clearScreenshotSet(client, set.id);
      }

      const uploadedIds: string[] = [];
      const lines: string[] = [];

      // Sequential on purpose: Apple orders a set by upload order, and a burst of
      // parallel reservations trips its rate limiter.
      for (const filePath of entry.files) {
        const file = loaded.get(filePath)!;

        try {
          const asset = await uploadScreenshotFile(client, {
            setId: set.id,
            filePath,
            buffer: file.buffer,
            fileName: file.fileName,
            wait: args.wait !== false,
          });

          uploadedIds.push(asset.id);

          if (asset.state.state === 'FAILED') {
            failedCount += 1;
            lines.push(`   ❌ ${file.fileName} — ${describeAssetState(asset.state)}`);
          } else {
            uploadedCount += 1;
            lines.push(`   ✅ ${file.fileName} — ${describeAssetState(asset.state)}`);
          }
        } catch (error: any) {
          failedCount += 1;
          lines.push(`   ❌ ${file.fileName} — ${error?.message ?? String(error)}`);
        }
      }

      // Pin the order explicitly rather than trusting upload order.
      if (uploadedIds.length > 1) {
        await client
          .patch(`/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, {
            data: uploadedIds.map((id) => ({ type: 'appScreenshots', id })),
          })
          .catch((error) => lines.push(`   ⚠️ Could not enforce ordering: ${error.message}`));
      }

      const header =
        `${entry.locale} → ${entry.displayType} (set ${set.id}${set.created ? ', created' : ''})` +
        (removed > 0 ? ` — ${removed} existing screenshot(s) removed` : '');

      report.push(`${header}\n${lines.join('\n')}`);
    }

    const localeCount = new Set(entries.map((entry) => entry.locale)).size;

    return `${failedCount === 0 ? '✅' : '⚠️'} Batch upload finished — ${uploadedCount} uploaded, ${failedCount} failed, across ${localeCount} locale(s) and ${entries.length} set(s).

${report.join('\n\n')}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — delete and reorder
// ---------------------------------------------------------------------------

export const deleteScreenshot = defineTool<{ screenshotId: string }>({
  name: 'screenshots_delete',
  description: 'Delete a screenshot',
  inputSchema: {
    type: 'object',
    properties: {
      screenshotId: { type: 'string', description: 'The ID of the appScreenshot to delete' },
    },
    required: ['screenshotId'],
  },
  handler: async ({ screenshotId }, client) => {
    await client.delete(`/v1/appScreenshots/${screenshotId}`);
    return `🗑️ Screenshot ${screenshotId} deleted.`;
  },
});

export const clearScreenshots = defineTool<{ setId: string }>({
  name: 'screenshots_clear_set',
  description: 'Delete every screenshot in a screenshot set (the set itself is kept)',
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The ID of the appScreenshotSet to empty' },
    },
    required: ['setId'],
  },
  handler: async ({ setId }, client) => {
    const removed = await clearScreenshotSet(client, setId);
    return removed === 0
      ? `Screenshot set ${setId} was already empty.`
      : `🗑️ ${removed} screenshot(s) deleted from set ${setId}.`;
  },
});

export const reorderScreenshots = defineTool<{ setId: string; screenshotIds: string[] }>({
  name: 'screenshots_reorder',
  description: 'Set the display order of the screenshots in a set',
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The ID of the appScreenshotSet' },
      screenshotIds: {
        type: 'array',
        description:
          'Every appScreenshot ID of the set, in the wanted order. The list must be complete — Apple replaces the whole relationship.',
        items: { type: 'string' },
      },
    },
    required: ['setId', 'screenshotIds'],
  },
  handler: async ({ setId, screenshotIds }, client) => {
    if (screenshotIds.length === 0) {
      throw new Error('`screenshotIds` cannot be empty — that would detach every screenshot.');
    }

    // Apple replaces the entire relationship, so an incomplete list silently
    // drops screenshots. Catch that here rather than after the damage.
    const { data } = await client.getAllPages(`/v1/appScreenshotSets/${setId}/appScreenshots`);
    const existing = new Set((data as any[]).map((shot) => shot.id));
    const missing = [...existing].filter((id) => !screenshotIds.includes(id));
    const unknown = screenshotIds.filter((id) => !existing.has(id));

    if (unknown.length > 0) {
      throw new Error(`These IDs do not belong to set ${setId}: ${unknown.join(', ')}`);
    }
    if (missing.length > 0) {
      throw new Error(
        `The order must list every screenshot of the set. Missing: ${missing.join(', ')}`
      );
    }

    await client.patch(`/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
      data: screenshotIds.map((id) => ({ type: 'appScreenshots', id })),
    });

    return `✅ Order updated for set ${setId}:\n${screenshotIds
      .map((id, index) => `${index + 1}. ${id}`)
      .join('\n')}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — app previews (videos), same three-step flow
// ---------------------------------------------------------------------------

export const listPreviewSets = defineTool<{ localizationId: string }>({
  name: 'previews_list_sets',
  description: 'List the app preview (video) sets of an app store version localization',
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the appStoreVersionLocalization',
      },
    },
    required: ['localizationId'],
  },
  handler: async ({ localizationId }, client) => {
    const { data } = await client.getAllPages(
      `/v1/appStoreVersionLocalizations/${localizationId}/appPreviewSets`
    );

    if (data.length === 0) return `No app preview sets on localization ${localizationId}.`;

    const lines = await Promise.all(
      (data as any[]).map(async (set) => {
        const previews = await client.getAllPages(`/v1/appPreviewSets/${set.id}/appPreviews`);
        return `• ${set.attributes?.previewType ?? '(unknown preview type)'} — ${
          previews.data.length
        } preview(s)${summarizeAssetHealth(previews.data)} — set ID: ${set.id}`;
      })
    );

    lines.sort((a, b) => a.localeCompare(b));

    return `🎬 App preview sets for localization ${localizationId}:\n\n${lines.join('\n')}`;
  },
});

export const listPreviews = defineTool<{ setId: string }>({
  name: 'previews_list',
  description: 'List the app previews of a preview set with their asset delivery state',
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The ID of the appPreviewSet' },
    },
    required: ['setId'],
  },
  handler: async ({ setId }, client) => {
    const { data } = await client.getAllPages(`/v1/appPreviewSets/${setId}/appPreviews`);

    if (data.length === 0) return `App preview set ${setId} is empty.`;

    const lines = (data as any[]).map((preview, index) => {
      const attributes = preview.attributes ?? {};
      return `${index + 1}. ${attributes.fileName ?? '(no name)'} — ${describeAssetState(
        attributes.assetDeliveryState ?? {}
      )}${attributes.previewFrameTimeCode ? ` — poster frame ${attributes.previewFrameTimeCode}` : ''} — ID: ${preview.id}`;
    });

    return `🎬 ${data.length} preview(s) in set ${setId}:\n\n${lines.join('\n')}`;
  },
});

export const uploadPreview = defineTool<{
  filePath: string;
  setId?: string;
  localizationId?: string;
  previewType?: string;
  previewFrameTimeCode?: string;
  wait?: boolean;
}>({
  name: 'previews_upload',
  description:
    'Upload one app preview video from a local file to a preview set (reserve, chunked upload, commit, then report the asset delivery state)',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Absolute path to the video file (.mp4, .mov or .m4v)',
      },
      setId: {
        type: 'string',
        description:
          'Target appPreviewSet ID. Omit it and pass localizationId + previewType to reuse or create the set automatically.',
      },
      localizationId: {
        type: 'string',
        description: 'The appStoreVersionLocalization ID (used when setId is not given)',
      },
      previewType: {
        type: 'string',
        description: `Apple previewType, required when setId is not given. ${PREVIEW_TYPE_DOC}`,
        enum: PREVIEW_TYPES,
      },
      previewFrameTimeCode: {
        type: 'string',
        description: 'Poster frame timecode, format "HH:MM:SS:FF" (optional)',
      },
      wait: {
        type: 'boolean',
        description: 'Poll until Apple finishes transcoding, up to 5 minutes (default true)',
      },
    },
    required: ['filePath'],
  },
  handler: async (args, client) => {
    const { buffer, fileName } = await loadFile(args.filePath);

    const extension = extname(fileName).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension)) {
      throw new Error(
        `"${fileName}" is not a recognised app preview video. Apple accepts ${[...VIDEO_EXTENSIONS].join(', ')}.`
      );
    }

    let setId = args.setId;
    let setNote = '';

    if (!setId) {
      if (!args.localizationId || !args.previewType) {
        throw new Error('Provide either `setId`, or both `localizationId` and `previewType`.');
      }
      const set = await resolvePreviewSet(client, args.localizationId, args.previewType);
      setId = set.id;
      setNote = set.created ? ' (set created)' : '';
    }

    const asset = await uploadPreviewFile(client, {
      setId,
      buffer,
      fileName,
      mimeType: extension === '.mp4' ? 'video/mp4' : 'video/quicktime',
      previewFrameTimeCode: args.previewFrameTimeCode,
      wait: args.wait !== false,
    });

    const failed = asset.state.state === 'FAILED';

    return `${failed ? '❌' : '✅'} App preview ${failed ? 'rejected' : 'uploaded'}: ${fileName}${setNote}
• Set: ${setId}
• Size: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB
• Checksum (MD5): ${md5Hex(buffer)}
• Preview ID: ${asset.id}
• Delivery: ${describeAssetState(asset.state)}`;
  },
});

export const deletePreview = defineTool<{ previewId: string }>({
  name: 'previews_delete',
  description: 'Delete an app preview video',
  inputSchema: {
    type: 'object',
    properties: {
      previewId: { type: 'string', description: 'The ID of the appPreview to delete' },
    },
    required: ['previewId'],
  },
  handler: async ({ previewId }, client) => {
    await client.delete(`/v1/appPreviews/${previewId}`);
    return `🗑️ App preview ${previewId} deleted.`;
  },
});

export const reorderPreviews = defineTool<{ setId: string; previewIds: string[] }>({
  name: 'previews_reorder',
  description: 'Set the display order of the app previews in a set',
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The ID of the appPreviewSet' },
      previewIds: {
        type: 'array',
        description: 'Every appPreview ID of the set, in the wanted order (the list must be complete)',
        items: { type: 'string' },
      },
    },
    required: ['setId', 'previewIds'],
  },
  handler: async ({ setId, previewIds }, client) => {
    if (previewIds.length === 0) {
      throw new Error('`previewIds` cannot be empty — that would detach every preview.');
    }

    const { data } = await client.getAllPages(`/v1/appPreviewSets/${setId}/appPreviews`);
    const existing = new Set((data as any[]).map((preview) => preview.id));
    const unknown = previewIds.filter((id) => !existing.has(id));
    const missing = [...existing].filter((id) => !previewIds.includes(id));

    if (unknown.length > 0) {
      throw new Error(`These IDs do not belong to set ${setId}: ${unknown.join(', ')}`);
    }
    if (missing.length > 0) {
      throw new Error(`The order must list every preview of the set. Missing: ${missing.join(', ')}`);
    }

    await client.patch(`/v1/appPreviewSets/${setId}/relationships/appPreviews`, {
      data: previewIds.map((id) => ({ type: 'appPreviews', id })),
    });

    return `✅ Order updated for preview set ${setId}:\n${previewIds
      .map((id, index) => `${index + 1}. ${id}`)
      .join('\n')}`;
  },
});

export const screenshotTools: Tool[] = [
  listScreenshotSets,
  listScreenshots,
  listVersionScreenshotOverview,
  createScreenshotSet,
  uploadScreenshot,
  uploadScreenshotsBatch,
  deleteScreenshot,
  clearScreenshots,
  reorderScreenshots,
  listPreviewSets,
  listPreviews,
  uploadPreview,
  deletePreview,
  reorderPreviews,
];
