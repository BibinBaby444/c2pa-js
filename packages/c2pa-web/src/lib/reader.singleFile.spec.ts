/**
 * Copyright 2025 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

/**
 * `fromBlobFragment` with `fragmentBaseOffset`: verifying one segment of a
 * single-file fragmented MP4 (byte-range HLS) without the whole file.
 *
 * The fixtures under test/assets/single-file were produced by signing two
 * ffmpeg testsrc2 renditions with the c2pa-rs single-file writer (one alone,
 * two as an ABR ladder sharing one manifest) and cutting each signed file at
 * its C2PA `merkle` uuid boxes. `layout.json` records where each segment sat
 * in the file, exactly what an HLS playlist's EXT-X-BYTERANGE provides.
 */

import { test, describe, expect } from 'test/methods.js';
import { getBlobForAsset } from 'test/utils.js';
import { singleFileLayout as layout } from 'test/assets/single-file/layout.js';
import type { ManifestStore } from '@stardustproof/c2pa-types';
import type { Settings } from './settings.js';
import type { C2paSdk } from './c2pa.js';

const assetUrls = import.meta.glob('../../test/assets/single-file/*.{mp4,m4s}', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>;

function assetUrl(file: string): string {
  const key = Object.keys(assetUrls).find(k => k.endsWith(`/${file}`));
  if (!key) {
    throw new Error(`fixture ${file} not found`);
  }
  return assetUrls[key];
}

// The fixtures are signed with the c2pa-rs test certificates, which no trust
// list contains; the hard binding is what these tests are about.
const noTrust: Settings = { verify: { verifyTrust: false } };

function statusCodes(store: ManifestStore, kind: 'success' | 'failure'): string[] {
  const active = store.validation_results?.activeManifest;
  return (active?.[kind] ?? []).map(s => s.code);
}

interface SegmentVerdict {
  state: string;
  success: string[];
  failure: string[];
}

// A hard-binding failure is reported in the manifest store, never thrown, so
// a player can render it. Any throw here is a regression (RPC arity, wasm
// conversion, ...) and fails the test.
async function verifySegment(
  c2pa: C2paSdk,
  initFile: string,
  segmentFile: string,
  fragmentBaseOffset?: number,
  settings: Settings | undefined = noTrust
): Promise<SegmentVerdict> {
  const init = await getBlobForAsset(assetUrl(initFile));
  const segment = await getBlobForAsset(assetUrl(segmentFile));
  const reader = await c2pa.reader.fromBlobFragment(
    'video/mp4',
    init,
    segment,
    settings,
    fragmentBaseOffset === undefined ? undefined : { fragmentBaseOffset }
  );
  expect(reader).not.toBeNull();
  const store = (await reader!.manifestStore()) as ManifestStore;
  return {
    state: store.validation_state as string,
    success: statusCodes(store, 'success'),
    failure: statusCodes(store, 'failure')
  };
}

function expectBound(result: SegmentVerdict) {
  expect(['Valid', 'Trusted']).toContain(result.state);
  expect(result.success).toContain('assertion.bmffHash.match');
  expect(result.failure).not.toContain('assertion.bmffHash.mismatch');
}

function expectRejected(result: SegmentVerdict) {
  expect(result.state).toBe('Invalid');
  expect(result.failure).toContain('assertion.bmffHash.mismatch');
}

describe('reader.fromBlobFragment with fragmentBaseOffset', () => {
  describe('single rendition signed on its own', () => {
    const rendition = layout['solo-360p'];

    test('verifies every segment at the offset it was cut from', async ({ c2pa }) => {
      expect(rendition.segments.length).toBeGreaterThan(1);
      for (const seg of rendition.segments) {
        expectBound(await verifySegment(c2pa, rendition.init, seg.file, seg.offset));
      }
    });

    test('rejects the same segment without the offset (multi-file behaviour)', async ({
      c2pa
    }) => {
      const seg = rendition.segments[1];
      expectRejected(await verifySegment(c2pa, rendition.init, seg.file));
      expectRejected(await verifySegment(c2pa, rendition.init, seg.file, 0));
    });

    test('rejects the right segment at the wrong offset', async ({ c2pa }) => {
      const seg = rendition.segments[1];
      expectRejected(await verifySegment(c2pa, rendition.init, seg.file, seg.offset + 1));
      expectRejected(await verifySegment(c2pa, rendition.init, seg.file, seg.offset - 1));
    });

    test('rejects a segment cut at the sidx instead of the merkle uuid', async ({ c2pa }) => {
      const cut = rendition.sidxCutOfSegment1;
      expectRejected(
        await verifySegment(c2pa, rendition.init, 'solo-360p.sidxcut01.m4s', cut.offset)
      );
    });

    test('works without settings, as in the README example', async ({ c2pa }) => {
      // The options argument must reach the wasm even when no settings are
      // passed (a different code path in the wasm reader).
      const seg = rendition.segments[3];
      expectBound(await verifySegment(c2pa, rendition.init, seg.file, seg.offset, undefined));
      expectRejected(await verifySegment(c2pa, rendition.init, seg.file, undefined, undefined));
    });

    test('throws on an offset that is not a non-negative safe integer', async ({ c2pa }) => {
      const init = await getBlobForAsset(assetUrl(rendition.init));
      const segment = await getBlobForAsset(assetUrl(rendition.segments[0].file));
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        await expect(
          c2pa.reader.fromBlobFragment('video/mp4', init, segment, noTrust, {
            fragmentBaseOffset: bad
          })
        ).rejects.toThrow(RangeError);
      }
    });
  });

  describe('ABR ladder sharing one manifest', () => {
    const high = layout['ladder-360p'];
    const low = layout['ladder-180p'];

    test('each rendition verifies its own segments against the shared manifest', async ({
      c2pa
    }) => {
      for (const rendition of [high, low]) {
        for (const seg of rendition.segments) {
          expectBound(await verifySegment(c2pa, rendition.init, seg.file, seg.offset));
        }
      }
    });

    test('a segment does not verify under the other rendition of the ladder', async ({
      c2pa
    }) => {
      const seg = low.segments[2];
      expectRejected(await verifySegment(c2pa, high.init, seg.file, seg.offset));
      const segHigh = high.segments[2];
      expectRejected(await verifySegment(c2pa, low.init, segHigh.file, segHigh.offset));
    });

    test('still needs the offset', async ({ c2pa }) => {
      const seg = low.segments[0];
      expectRejected(await verifySegment(c2pa, low.init, seg.file));
    });
  });
});
