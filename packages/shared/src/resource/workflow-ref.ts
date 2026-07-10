import path from "path"
import { z } from "zod"

/**
 * WorkflowRef — unified handling for workflow references.
 *
 * Supports two formats:
 *   - Resource-style: "group/name" (e.g. "built-in/bug-hunter")
 *   - File-style: "name.yaml" (e.g. "bug-hunter.yaml")
 *
 * Sanitization maps "/" → "__" for safe filesystem use (state snapshots, etc).
 */

/** Valid workflow_ref: alphanumeric start, then letters/digits/dots/hyphens/underscores, optional single "/" separator, optional .yaml/.yml suffix */
const WORKFLOW_REF_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?:\.ya?ml)?$/

export class WorkflowRef {
  /** Sanitize for filesystem use (filenames, state snapshots): "/" → "__" */
  static sanitize(ref: string): string {
    return ref.replace(/[\/\\]/g, "__")
  }

  /** Restore original ref from sanitized form: "__" → "/" */
  static desanitize(sanitized: string): string {
    return sanitized.replace(/__/g, "/")
  }

  /**
   * Parse into { group, name }.
   * "group/name"     → { group: "group", name: "name" }
   * "name.yaml"      → { group: undefined, name: "name.yaml" }
   * "group/name.yml" → { group: "group", name: "name.yml" }
   */
  static parse(ref: string): { group?: string; name: string } {
    const slashIdx = ref.indexOf("/")
    if (slashIdx > 0) {
      return { group: ref.slice(0, slashIdx), name: ref.slice(slashIdx + 1) }
    }
    return { name: ref }
  }

  /**
   * Resolve to filesystem path within a workflows directory.
   * Handles group subdirs: "built-in/bug-hunter" → workflowsDir/built-in/bug-hunter
   * Plain refs: "bug-hunter.yaml" → workflowsDir/bug-hunter.yaml
   */
  static toPath(workflowsDir: string, ref: string): string {
    const { group, name } = WorkflowRef.parse(ref)
    return group
      ? path.join(workflowsDir, group, name)
      : path.join(workflowsDir, name)
  }

  /** Validate workflow_ref format */
  static isValid(ref: string): boolean {
    return WORKFLOW_REF_RE.test(ref)
  }

  /** Zod schema for use in validation pipelines */
  static zodSchema() {
    return z
      .string()
      .min(1)
      .regex(WORKFLOW_REF_RE, {
        message: "Invalid workflow_ref: use 'name', 'name.yaml', or 'group/name'",
      })
  }
}
