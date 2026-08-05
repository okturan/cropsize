# object-detection Specification

## Purpose

Define how the browser finds, rotates, presents, merges, and exports multiple document-like items from one scan.

## Requirements

### Requirement: Several items on one scan

The browser build SHALL find every document-like item on a scan and treat each as a separate output. A page SHALL be produced per item.

#### Scenario: A flatbed holding several documents

- **WHEN** a scan holds more than one document
- **THEN** each is found and listed separately
- **AND** exporting produces one page per item

#### Scenario: A scan holding one document

- **WHEN** a scan holds a single document
- **THEN** the result is one item
- **AND** the single-document path is not made worse by the multi-item path existing

### Requirement: Each item carries its own rotation

Every found item SHALL be straightened by its own angle, taken from the rectangle fitted to it. A single rotation SHALL NOT be applied across all items.

#### Scenario: Items lying at different angles

- **WHEN** several photographs lie on a platen at different angles
- **THEN** each is straightened by its own angle
- **AND** each exported page is upright

#### Scenario: An item with no text

- **WHEN** an item carries no text to measure a tilt from, as a photograph does not
- **THEN** its angle still comes from the shape fitted to it

### Requirement: Overlapping candidates are offered, not resolved silently

Where the segmenter proposes several overlapping candidates for the same region, the system SHALL keep them and let a person choose. It SHALL NOT pick one and discard the rest without saying so.

#### Scenario: A document inside a sleeve

- **WHEN** a passport sits inside a plastic sleeve, so the segmenter proposes the sleeve and each page but never the spread
- **THEN** the alternatives are available to cycle through
- **AND** the reading for each is shown so the choice is informed

#### Scenario: Choosing an alternative

- **WHEN** a person cycles to a different candidate
- **THEN** the crop, the measurement and the preview all follow it

### Requirement: Items can be merged

A person SHALL be able to select two or more found items and combine them into one, because a grouping a person recognises as a single document is not always a single shape to a segmenter.

#### Scenario: Two facing pages

- **WHEN** two pages of one spread are found as separate items
- **AND** a person selects both and merges them
- **THEN** they become one item covering both
- **AND** its measurement reflects the combined size

#### Scenario: Undoing a merge

- **WHEN** a person merges items
- **THEN** the parts remain reachable, so the merge can be reversed
