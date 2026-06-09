import assert from "node:assert/strict";
import test from "node:test";

import { getSectionDeparture } from "../src/shared/bahn-api";

test("getSectionDeparture prefers abfahrtsZeitpunkt", () => {
  assert.equal(
    getSectionDeparture({
      abfahrtsZeitpunkt: "2026-06-21T18:00:00",
      abfahrt: { sollzeit: "2026-06-21T18:05:00" },
    }),
    "2026-06-21T18:00:00"
  );
});

test("getSectionDeparture falls back to abfahrt.sollzeit", () => {
  assert.equal(
    getSectionDeparture({
      abfahrt: { sollzeit: "2026-06-21T18:05:00" },
    }),
    "2026-06-21T18:05:00"
  );
});

test("getSectionDeparture handles null abfahrtsZeitpunkt", () => {
  assert.equal(
    getSectionDeparture({
      abfahrtsZeitpunkt: null,
      abfahrt: { sollzeit: "2026-06-21T18:05:00" },
    }),
    "2026-06-21T18:05:00"
  );
});

test("getSectionDeparture returns undefined without a departure", () => {
  assert.equal(getSectionDeparture(undefined), undefined);
  assert.equal(getSectionDeparture(null), undefined);
  assert.equal(getSectionDeparture({}), undefined);
});
