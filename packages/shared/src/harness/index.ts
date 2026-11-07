// Harness module — barrel exports
//
// The Harness *configuration/strategy/agent* layers were retired in the
// AI-native supervision redesign. What remains here is the detector signal
// vocabulary (DiagnosisReport + events) and the shared utils detectors use.
// The stable supervision contract lives in `src/runtime/`.

export type {
  DiagnosisReport,
  InterventionAction,
  HarnessNodeStatus,
  HarnessSSEEvent,
  HarnessEvent,
} from "./types"

export { computeErrorHash, simpleHash } from "./utils"
export type { ErrorResultLike } from "./utils"
