---
'@stardustproof/c2pa-web': minor
'@stardustproof/c2pa-wasm': minor
---

`reader.fromBlobFragment` accepts a fifth argument, `{ fragmentBaseOffset }`, for a fragment cut out of a single-file fragmented MP4 (byte-range HLS). Such an asset's hard binding covers absolute box offsets, so a segment can only be verified when the reader knows where it sat in the file. The bytes passed must reproduce the Merkle leaf: by default the init blob is everything before the first C2PA `merkle` uuid box and each fragment runs from one `merkle` box to the next; a playlist cut at each `sidx` needs regrouping first (the `@stardustproof/c2pa-bridges` adapters do it). See `FragmentOptions`. Segment files keep working without the option. The wasm is now built from castlabs/c2pa-rs#18 plus a backport of contentauth/c2pa-rs#2374 (a builder restored from an archive no longer signs the archive's metadata assertion). That revision also selects the right Merkle map when one manifest covers an ABR ladder of renditions and rejects a fragmented Merkle map without `initHash` as `assertion.bmffHash.malformed`.
