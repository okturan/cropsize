# document-source Specification

## Purpose

Define how scans enter the browser with physical scale, page structure, and local-only processing preserved.

## Requirements

### Requirement: Physical scale comes from the source

A scan SHALL be read with its physical scale intact, taken from the PDF's own page geometry, because that is what makes true-size output possible without asking a person what the object is. Rendering resolution SHALL NOT change the measurement.

#### Scenario: The same content at different resolutions

- **WHEN** the same document is scanned at 150, 300, 600 and 1200 dpi
- **THEN** the measured physical size is the same in every case, within a fraction of a millimetre

#### Scenario: A file with no scale

- **WHEN** a raster file carries no resolution information
- **THEN** the system says the scale is unknown
- **AND** does not present a physical size it cannot support

### Requirement: Multi-page documents are never silently truncated

The system SHALL NOT read only the first page of a multi-page document without saying so. Every page SHALL be reachable.

#### Scenario: Opening a multi-page PDF

- **WHEN** a document with more than one page is opened
- **THEN** the number of pages is visible
- **AND** any page can be selected

#### Scenario: Working across pages

- **WHEN** a person moves to another page
- **THEN** that page's own crop, rotation and measurement apply
- **AND** work already done on other pages is not lost

### Requirement: Nothing leaves the machine

A scan SHALL be read and processed in the browser. It SHALL NOT be uploaded.

#### Scenario: Opening a scan

- **WHEN** a person opens a document
- **THEN** no request carrying its contents is made
- **AND** the only network traffic is fetching the model, which is cached after the first visit
