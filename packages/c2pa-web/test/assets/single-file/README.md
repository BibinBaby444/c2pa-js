# Single-file fragmented MP4 fixtures

Used by `src/lib/reader.singleFile.spec.ts` to exercise
`reader.fromBlobFragment(..., { fragmentBaseOffset })`: verifying one
byte-range segment of a single-file fragmented MP4 without the whole file.

Three signed files were produced and then cut at their C2PA `merkle` uuid
boxes:

| Prefix | Content | Signed as |
|---|---|---|
| `solo-360p` | ffmpeg `testsrc2`, 320x180, 8 s, 1 s fragments, per-fragment `sidx` | one asset on its own (one Merkle map) |
| `ladder-360p`, `ladder-180p` | same, 320x180 and 160x90 | one ABR ladder: one manifest, one Merkle map per rendition |

For each prefix: `<prefix>.init.mp4` is every byte before the first `merkle`
uuid box; `<prefix>.segNN.m4s` runs from `merkle` uuid box N to the next one
(the last one to end of file). `layout.ts` records each segment's absolute
offset in the signed file, which is what an HLS `EXT-X-BYTERANGE` provides.
`<prefix>.sidxcut01.m4s` is fragment 1 cut the wrong way, from its `sidx` to
the end of its `mdat`, for the negative test.

Signed with the c2pa-rs test certificates (`sdk/tests/fixtures/certs/es256.*`),
so the specs disable trust verification.

## Regenerating

```sh
for r in "360p 320x180" "180p 160x90"; do set -- $r
  ffmpeg -f lavfi -i testsrc2=size=$2:rate=25 -t 8 -c:v libx264 -preset veryfast \
    -threads 1 -g 25 -bf 0 -pix_fmt yuv420p \
    -movflags +empty_moov+frag_keyframe+default_base_moof+dash -y unsigned-$1.mp4
done
```

Sign with the castlabs c2pa-rs fork (the single-file writer), for example from
a scratch `sdk/examples/` program:

```rust
let signer = c2pa::create_signer::from_keys(&cert_pem, &key_pem, c2pa::SigningAlg::Es256, None)?;
let definition = r#"{"title":"single-file fragments","assertions":[{"label":"c2pa.actions","data":{"actions":[{"action":"c2pa.created","digitalSourceType":"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation"}]}}]}"#;
c2pa::Builder::default().with_definition(definition)?
    .sign_file(signer.as_ref(), "unsigned-360p.mp4", "solo-360p.mp4")?;
c2pa::Builder::default().with_definition(definition)?
    .sign_ladder_files(signer.as_ref(), &["unsigned-360p.mp4", "unsigned-180p.mp4"], &["ladder-360p.mp4", "ladder-180p.mp4"])?;
```

Then cut each signed file at its `merkle` uuid boxes (top-level `uuid` boxes
with the C2PA usertype `d8fec3d6-1b0e-483c-9297-5828877ec481` and purpose
`merkle`), writing the init prefix, the segments and `layout.ts`.
