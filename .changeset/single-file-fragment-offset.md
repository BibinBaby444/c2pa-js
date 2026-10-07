---
'@stardustproof/c2pa-web': minor
'@stardustproof/c2pa-wasm': minor
---

`reader.fromBlobFragment` accepts a fifth argument, `{ fragmentBaseOffset }`, for a fragment cut out of a single-file fragmented MP4 (byte-range HLS). Such an asset's hard binding covers absolute box offsets, so a segment can only be verified when the reader knows where it sat in the file. The bytes passed must reproduce the Merkle leaf: by default the init blob is everything before the first C2PA `merkle` uuid box and each fragment runs from one `merkle` box to the next; a playlist cut at each `sidx` needs regrouping first (the `@stardustproof/c2pa-bridges` adapters do it) unless the asset was signed with `sidx` excluded. See `FragmentOptions`. Segment files keep working without the option. The wasm is now built from the castlabs c2pa-rs fork, which also selects the right Merkle map when one manifest covers an ABR ladder of renditions.
