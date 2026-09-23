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
fixtures/private/ilkyaz.pdf -> <archive>/İlkyaz/Documents/IDs-and-Passports/<passport scan>.pdf
fixtures/private/irene.pdf  -> <archive>/Irene/Documents/IDs-and-Passports/<passport scan>.pdf
```

where `<archive>` is the owner's document archive. The real file names carry document
numbers, which do not belong in a public repository; `ls -l fixtures/private` shows them.

Two further ignored links hold phone photos of an ID card lying on a plain surface, front
and back. They are not in the manifest; `web/tests/detect-photo.test.ts` uses them to make
sure the card is found rather than the surface, and passes trivially where they are absent:

```text
fixtures/private/okan-id-front.jpg     -> <archive>/Okan/Documents/IDs-and-Passports/<ID card photo, front>.jpg
fixtures/private/okan-id-back.jpg      -> <archive>/Okan/Documents/IDs-and-Passports/<ID card photo, back>.jpg
fixtures/private/irene-ikamet-front.jpg -> <archive>/Irene/Documents/IDs-and-Passports/<residence permit photo, front>.jpg
fixtures/private/irene-ikamet-back.jpg  -> <archive>/Irene/Documents/IDs-and-Passports/<residence permit photo, back>.jpg
fixtures/private/ilkyaz-id-front.jpg    -> <archive>/İlkyaz/Documents/IDs-and-Passports/<ID card photo, front>.jpg
fixtures/private/ilkyaz-id-back.jpg     -> <archive>/İlkyaz/Documents/IDs-and-Passports/<ID card photo, back>.jpg
```

The first pair is a card lying on a plain surface; the other two are photos taken tight on a
card, where the frame itself is the document. `web/tests/card-photo.test.ts` pins the fitted
card corners on all six to within 3 pixels; those corners were checked by eye on magnified
overlays, on the card face and outside the glare and the shadow on every side.

A further ignored folder, `fixtures/private/docs`, links 27 more documents from the same
archive: phone photos of printed sheets on a desk (`bg-sheet-*`), a drawing, a staff ID card
front and back, a diploma and a driving licence, and flatbed PDFs (`scan-*`) of certificates,
civil registers, a consent form, a contract, a deed, a family booklet and passports. The
document fitter's rules were tuned on these by eye, and `web/tests/document-photo.test.ts`
pins what detection keeps of each: how every side was found and where the corners fall.

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
