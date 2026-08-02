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
fixtures/private/ilkyaz.pdf -> /Users/okan/Downloads/ilkyaz pspt.pdf
fixtures/private/irene.pdf  -> /Users/okan/Downloads/irene pspt.pdf
```

On another machine, either create those two ignored links or set
`CROPSIZE_PRIVATE_FIXTURES_DIR` to a directory containing the original filenames recorded in
the manifest. Tests skip private rows when neither source exists; the public row always runs.

The reference corpus command is:

```bash
CROPSIZE_RUN_MODEL_FIXTURES=1 ./.venv/bin/pytest tests/test_corpus.py -q
```

Model-backed rows are opt-in so the ordinary suite still needs no model weights.

Rust does not parse PDFs in its test build. Materialise deterministic grayscale PNGs for
that suite after installing the private links:

```bash
./.venv/bin/python scripts/materialize_corpus.py
```
