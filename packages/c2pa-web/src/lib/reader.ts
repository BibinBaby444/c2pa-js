/**
 * Copyright 2025 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { Manifest, ManifestStore } from '@stardustproof/c2pa-types';
import { AssetTooLargeError, UnsupportedFormatError } from './error.js';
import { isSupportedReaderFormat } from './supportedFormats.js';
import type { WorkerManager } from './worker/workerManager.js';
import { Settings, settingsToWasmJson } from './settings.js';

// 1 GB
export const MAX_SIZE_IN_BYTES = 10 ** 9;

/**
 * A collection of functions that permit the creation of Reader objects from various sources.
 */
export interface ReaderFactory {
  /**
   * Create a {@link Reader} from an asset's format and a blob of its bytes.
   *
   * @param format Asset format.
   * @param blob Blob of asset bytes.
   * @param settings Optional context settings for the reader. Will override any values inherited by the top-level settings passed to createC2pa.
   * @returns A {@link Reader} object or null if no C2PA metadata was found.
   */
  fromBlob: (
    format: string,
    blob: Blob,
    settings?: Settings
  ) => Promise<Reader | null>;

  /**
   * Create a {@link Reader} from a fragmented asset's initialization segment and one fragment.
   *
   * For a fragment stored as its own file (DASH/HLS with separate segment files) pass the two blobs.
   * For a fragment cut out of a single-file fragmented MP4 (byte-range HLS) also pass
   * `options.fragmentBaseOffset`: see {@link FragmentOptions}.
   *
   * @param format Asset format.
   * @param init Blob of initial fragment bytes.
   * @param fragment Blob of fragment bytes.
   * @param settings Optional context settings for the reader. Will override any values inherited by the top-level settings passed to createC2pa.
   * @param options Optional {@link FragmentOptions}.
   * @returns A {@link Reader} object or null if no C2PA metadata was found.
   */
  fromBlobFragment: (
    format: string,
    init: Blob,
    fragment: Blob,
    settings?: Settings,
    options?: FragmentOptions
  ) => Promise<Reader | null>;
}

/**
 * Options for {@link ReaderFactory.fromBlobFragment}.
 */
export interface FragmentOptions {
  /**
   * Absolute byte offset of the fragment's first byte within a single-file fragmented MP4.
   *
   * The hard binding of such an asset covers absolute box offsets, so a fragment cut out of it
   * (one byte-range HLS segment, for instance) can only be verified when the reader knows where
   * it sat in the file. The cut must follow the specification's leaf boundaries: the init blob is
   * everything before the first C2PA `merkle` uuid box, and each fragment runs from one `merkle`
   * uuid box to the next (the last one to end of file). Any other cut, or the wrong offset, reports
   * `assertion.bmffHash.mismatch`.
   *
   * Omit it (or pass `0`) for fragments that are their own files. Must be a non-negative safe
   * integer; anything else throws.
   */
  fragmentBaseOffset?: number;
}

/**
 * Exposes methods for reading C2PA data out of an asset.
 *
 * @example Getting an asset's active manifest:
 * ```
 * const reader = await c2pa.reader.fromBlob(blob.type, blob);
 *
 * const activeManifest = await reader.activeManfiest();
 * ```
 */
export interface Reader {
  /**
   * @returns The label of the active manifest.
   */
  activeLabel: () => Promise<string | null>;

  /**
   * @returns The asset's full {@link ManifestStore} containing all its manifests, validation statuses, and the URI of the active manifest.
   */
  manifestStore: () => Promise<ManifestStore>;

  /**
   * @returns The asset's active {@link Manifest}.
   */
  activeManifest: () => Promise<Manifest>;

  /**
   * @returns The asset's full {@link ManifestStore}.
   *
   * @deprecated Use {@link manifestStore} instead.
   */
  json: () => Promise<any>;

  /**
   * @returns The asset's manifest store as crJSON.
   */
  crJson: () => Promise<any>;

  /**
   * Resolves a URI reference to a binary object (e.g. a thumbnail) in the resource store.
   *
   * @param uri URI of the binary object to resolve.
   * @returns A Uint8Array of the resource's bytes.
   *
   * @example Retrieving a thumbnail from the resource store:
   * ```
   * const reader = await c2pa.reader.fromBlob(blob.type, blob);
   *
   * const activeManifest = await reader.activeManifest();
   *
   * const thumbnailBuffer = await reader.resourceToBytes(activeManifest.thumbnail!.identifier);
   * ```
   */
  resourceToBytes: (uri: string) => Promise<Uint8Array<ArrayBuffer>>;

  /**
   * Dispose of this Reader, freeing the memory it occupied and preventing further use. Call this whenever the Reader is no longer needed.
   */
  free: () => Promise<void>;
}

/**
 * @param worker - Worker (via WorkerManager) to be associated with this reader factory.
 * @returns A {@link ReaderFactory} object containing reader creation methods.
 */
export function createReaderFactory(worker: WorkerManager): ReaderFactory {
  const { tx } = worker;

  const registry = new FinalizationRegistry<number>(async (id) => {
    await tx.reader_free(id);
  });

  return {
    async fromBlob(
      format: string,
      blob: Blob,
      settings?: Settings
    ): Promise<Reader | null> {
      if (!isSupportedReaderFormat(format)) {
        throw new UnsupportedFormatError(format);
      }

      if (blob.size > MAX_SIZE_IN_BYTES) {
        throw new AssetTooLargeError(blob.size);
      }

      try {
        const settingsJson = settings && (await settingsToWasmJson(settings));

        const readerId = await tx.reader_fromBlob(format, blob, settingsJson);

        const reader = createReader(worker, readerId, () => {
          registry.unregister(reader);
        });
        registry.register(reader, readerId, reader);

        return reader;
      } catch (e: unknown) {
        return handleReaderCreationError(e);
      }
    },

    async fromBlobFragment(
      format: string,
      init: Blob,
      fragment: Blob,
      settings?: Settings,
      options?: FragmentOptions
    ) {
      if (!isSupportedReaderFormat(format)) {
        throw new UnsupportedFormatError(format);
      }

      if (init.size > MAX_SIZE_IN_BYTES) {
        throw new AssetTooLargeError(init.size);
      }

      const fragmentBaseOffset = options?.fragmentBaseOffset;
      if (
        fragmentBaseOffset !== undefined &&
        !(Number.isSafeInteger(fragmentBaseOffset) && fragmentBaseOffset >= 0)
      ) {
        throw new RangeError(
          `fragmentBaseOffset must be a non-negative safe integer, got ${String(
            fragmentBaseOffset
          )}`
        );
      }

      try {
        const settingsJson = settings && (await settingsToWasmJson(settings));

        const readerId = await tx.reader_fromBlobFragment(
          format,
          init,
          fragment,
          settingsJson,
          fragmentBaseOffset
        );

        const reader = createReader(worker, readerId, () => {
          registry.unregister(reader);
        });
        registry.register(reader, readerId, reader);

        return reader;
      } catch (e: unknown) {
        return handleReaderCreationError(e);
      }
    }
  };
}

function handleReaderCreationError(maybeError: unknown): null {
  if (
    maybeError instanceof Error &&
    maybeError.message === 'C2pa(JumbfNotFound)'
  ) {
    return null;
  }

  throw maybeError;
}

function createReader(
  worker: WorkerManager,
  id: number,
  onFree: () => void
): Reader {
  const { tx } = worker;

  return {
    async activeLabel(): Promise<string | null> {
      const label = await tx.reader_activeLabel(id);
      return label;
    },
    async manifestStore(): Promise<ManifestStore> {
      const manifestStore = await tx.reader_manifestStore(id);
      return manifestStore;
    },
    async activeManifest(): Promise<Manifest> {
      const activeManifest = await tx.reader_activeManifest(id);

      return activeManifest;
    },
    async json(): Promise<any> {
      const json = await tx.reader_json(id);

      const manifestStore = JSON.parse(json);

      return manifestStore;
    },
    async crJson(): Promise<any> {
      const crJson = await tx.reader_crJson(id);
      return JSON.parse(crJson);
    },
    async resourceToBytes(uri: string): Promise<Uint8Array<ArrayBuffer>> {
      const buffer = await tx.reader_resourceToBytes(id, uri);
      return buffer;
    },
    async free(): Promise<void> {
      onFree();
      await tx.reader_free(id);
    }
  };
}
