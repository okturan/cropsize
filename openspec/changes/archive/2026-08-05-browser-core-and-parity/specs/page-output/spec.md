## ADDED Requirements

### Requirement: The preview is the output

What the preview shows SHALL be produced by the same code that writes the file. The two SHALL NOT be able to disagree.

#### Scenario: Changing any setting

- **WHEN** a person changes the sheet, the size mode, the margin, the contrast or the crop
- **THEN** the preview updates from the same composition the export uses
- **AND** the exported file matches what was shown

### Requirement: Printed size is stated and honoured

The system SHALL state the physical size a crop will print at, and the exported PDF SHALL match it.

#### Scenario: Real size

- **WHEN** a person keeps the measured size
- **THEN** the stated size is the size measured on the scan
- **AND** the exported page carries the content at that size

#### Scenario: A known size

- **WHEN** a person forces a known size, such as an ID-1 card at 85.6 by 54 mm
- **THEN** the content is fitted inside that box, not merely matched on width, because an ICAO ID-3 page and an ID-3 spread are both 125 mm wide and would otherwise behave identically

#### Scenario: Filling the sheet

- **WHEN** a person chooses to fill the sheet
- **THEN** the result is stated as not to scale

### Requirement: Output resolution can be chosen

A person SHALL be able to choose the resolution of the exported file. The default SHALL match the source, so a scan is neither thrown away nor upsampled for nothing.

#### Scenario: Default

- **WHEN** no choice is made
- **THEN** the export matches the source resolution

#### Scenario: An explicit choice

- **WHEN** a person picks a resolution
- **THEN** the export uses it
- **AND** the physical size is unchanged

### Requirement: Nothing states a fact it has not verified

The interface SHALL NOT claim a state that has not happened. This applies to model readiness, download progress, and what an operation did.

#### Scenario: Before the model is fetched

- **WHEN** the model has not been downloaded
- **THEN** the interface says so, with the size it will cost
- **AND** does not describe the model as ready or running

#### Scenario: While loading

- **WHEN** the model is downloading or a session is being built
- **THEN** progress reflects the whole operation
- **AND** a step that reports nothing while it works is labelled rather than left as a full bar sitting still

#### Scenario: When an operation is degraded

- **WHEN** the browser is not cross-origin isolated, so inference runs on a single thread
- **THEN** the interface says so
- **AND** does not silently run several times slower
