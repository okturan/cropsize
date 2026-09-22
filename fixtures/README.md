# Golden fixtures

`corpus.json` is the numeric contract shared by Python, browser and Rust tests. It records
the expected skew, detected box, physical size and trim effect for every scan, together with
physical tolerances and a SHA-256 digest so a different file cannot silently inherit the
same answers.

The synthetic sample under `public/` is safe to commit and publish. The two passport scans
are private identity documents and must never enter Git, a package, CI artifacts or a
deployment. Their canonical files stay wherever their owner keeps them. On this machine the
ignored local paths are symlinks:

```text
fixtures/private/ilkyaz.pdf -> <iCloud>/LongTermStorage/People/İlkyaz/Documents/IDs-and-Passports/İlkyaz-Pasaport-COL-<redacted>-issued2021-expires2031-scan.pdf
fixtures/private/irene.pdf  -> <iCloud>/LongTermStorage/People/Irene/Documents/IDs-and-Passports/Irene-Pasaport-COL-<redacted>-issued2021-expires2031-scan.pdf
```

where `<iCloud>` is `~/Library/Mobile Documents/com~apple~CloudDocs`.

Two further ignored links hold phone photos of an ID card lying on a plain surface, front
and back. They are not in the manifest; `web/tests/detect-photo.test.ts` uses them to make
sure the card is found rather than the surface, and passes trivially where they are absent:

```text
fixtures/private/okan-id-front.jpg -> <iCloud>/LongTermStorage/People/Okan/Documents/IDs-and-Passports/Okan-TCKimlik-<redacted>-valid2026-2036-photo-front.jpg
fixtures/private/okan-id-back.jpg  -> <iCloud>/LongTermStorage/People/Okan/Documents/IDs-and-Passports/Okan-TCKimlik-<redacted>-valid2026-2036-photo-back.jpg
```

If a link's target moves, the private rows skip silently; check with `ls -L`.

On another machine, either create those two ignored links or set
`CROPSIZE_PRIVATE_FIXTURES_DIR` to a directory containing the original filenames recorded in
the manifest. Tests skip private rows when neither source exists; the public row always runs.

The reference corpus command is:

```bash
CROPSIZE_RUN_MODEL_FIXTURES=1 ./.venv/bin/pytest tests/test_corpus.py -q          # macOS/Linux
$env:CROPSIZE_RUN_MODEL_FIXTURES = 1; .\.venv\Scripts\pytest tests\test_corpus.py -q   # Windows
```

Model-backed rows are opt-in so the ordinary suite still needs no model weights.

The trim expectation was recorded from the Python build, which trims to the outline of a
full-resolution mask. The browser trims to the convex hull of the model's 256 pixel mask,
drawn as a polygon with a soft edge, so on the sleeve scans it clears up to 0.4% fewer
pixels than Python does. The private rows carry a 0.004 tolerance for that; the public sample
agrees within 0.003.

Rust does not parse PDFs in its test build. Materialise deterministic grayscale PNGs for
that suite after installing the private links:

```bash
./.venv/bin/python scripts/materialize_corpus.py        # macOS/Linux
.\.venv\Scripts\python scripts\materialize_corpus.py    # Windows
```
