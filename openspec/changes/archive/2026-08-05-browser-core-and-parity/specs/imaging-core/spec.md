## ADDED Requirements

### Requirement: One implementation of the imaging maths

The imaging maths SHALL exist in exactly one implementation. Skew estimation, edge snapping, mask cleanup, outline trimming, rotated-rect extraction and page layout arithmetic SHALL live in the shared core, and the browser build SHALL call it rather than carry its own copy.

#### Scenario: A function is ported

- **WHEN** a function moves into the core
- **THEN** its TypeScript counterpart is deleted rather than kept alongside
- **AND** every caller goes through the core binding

#### Scenario: Maths is added later

- **WHEN** new imaging maths is needed by either build
- **THEN** it is written in the core
- **AND** it is not written in TypeScript or Python first

### Requirement: Known answers are pinned by fixtures

The core SHALL be tested against a corpus of fixture scans with recorded expected values. The corpus SHALL cover skew angle, detected box, measured physical size, and the proportion of a crop that trimming changes. Tolerances SHALL be stated as physical quantities in millimetres and degrees, not as exact pixel equality, because a reimplementation of contour tracing or minimum-area rectangle can be correct and still differ by a pixel.

#### Scenario: Skew is measured on the corpus

- **WHEN** skew estimation runs against the fixture scans
- **THEN** it returns -2.4 degrees for the sample, 1.1 for ilkyaz and -1.4 for irene
- **AND** each is within 0.3 degrees of the recorded value

#### Scenario: Physical size is measured on the corpus

- **WHEN** a document is detected and measured on the fixture scans
- **THEN** the sample measures 105 by 148 mm within 1 mm
- **AND** an ICAO ID-3 passport spread measures 125 by 176 mm within 3 mm

#### Scenario: A change moves a number

- **WHEN** a change alters any value in the fixture table
- **THEN** the table is updated in the same change
- **AND** the new value is visible in review rather than absorbed silently

#### Scenario: Both suites assert the same corpus

- **WHEN** the core's own tests pass
- **AND** the browser's tests run against the built WebAssembly
- **THEN** both assert the same fixture table

### Requirement: Straightening measures tilt correctly

Skew estimation SHALL find the rotation that makes a document level, searching plus and minus 5 degrees. It SHALL NOT favour zero degrees as an artefact of its own arithmetic, and it SHALL ignore the outer margin of the frame, where a scanner bezel and platen edge are axis aligned however the document sits.

#### Scenario: A tilted document

- **WHEN** a scan is tilted by a known angle within the search range
- **THEN** the measured angle matches that angle within 0.3 degrees
- **AND** the sign is such that applying it makes the document level

#### Scenario: A document that is already level

- **WHEN** a scan has no tilt
- **THEN** the measured angle is zero
- **AND** zero is reached because it is the best answer, not because whole-number row coordinates give it a sharper profile than any other angle

#### Scenario: A scan with a strong axis-aligned frame

- **WHEN** the scan carries a scanner bezel or platen edge parallel to the image border
- **THEN** the measured angle still reflects the document
- **AND** is not pulled to zero by the frame

### Requirement: The document outline never deletes part of the document

Mask cleanup SHALL produce a silhouette that can only grow relative to what the segmenter returned, never shrink it. A document is a convex shape, so the outline SHALL be derived in a way that bridges gaps such as the gutter between two facing pages.

#### Scenario: A mask split into pieces

- **WHEN** the segmenter returns a mask broken into separate regions, as it does at the gutter of a passport spread
- **THEN** the outline spans all of them
- **AND** no region is discarded

#### Scenario: A mask with interior gaps

- **WHEN** the segmenter leaves gaps inside the document over flat bright areas
- **THEN** the outline covers them
- **AND** trimming does not punch holes through the page

#### Scenario: Trimming a whole document

- **WHEN** trimming runs on a correctly detected document
- **THEN** it changes less than 1 percent of the crop to white
- **AND** what it changes is at the corners

### Requirement: Trimming respects the crop it is given

Outline trimming SHALL be positioned by the crop it is asked to trim. When a person adjusts the crop by hand, the outline SHALL NOT be stretched onto the new rectangle.

#### Scenario: The automatic crop

- **WHEN** trimming runs on the crop the detector produced
- **THEN** the outline's corners land on the crop's corners

#### Scenario: A hand-adjusted crop

- **WHEN** a person drags the crop to a region in the middle of the document, away from any corner
- **THEN** trimming changes nothing, because none of that region is outside the document

### Requirement: Data crosses the boundary without copying frames

The core SHALL accept and return image data as views over its own linear memory. A full-resolution frame SHALL NOT be copied on each call.

#### Scenario: A frame is processed repeatedly

- **WHEN** the same frame is passed through several core operations while a person adjusts settings
- **THEN** the frame is allocated once and reused
- **AND** no per-call copy of the frame is made
