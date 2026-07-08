import fs from "fs"
import type { VerifyResult, VerifyStepResult, ResourceType } from "./types"
import type { RegistryStore } from "./registry-store"
import type { LockManager } from "./lock-manager"

/**
 * VerifyStep — pluggable verification step.
 * Phase 1: fileExists, registry, lock (three-piece set).
 * Phase 2: add consumerVisibilityStep.
 */
export interface VerifyStep {
  name: string
  verify(
    type: ResourceType,
    name: string,
    installPath: string,
    ctx: VerifyContext,
  ): VerifyStepResult
}

export interface VerifyContext {
  registry: RegistryStore
  lock: LockManager
}

// ── Phase 1 Steps ───────────────────────────────────────────────

const fileExistsStep: VerifyStep = {
  name: "fileExists",
  verify(type, name, installPath) {
    const exists = fs.existsSync(installPath)
    return {
      step: "fileExists",
      passed: exists,
      message: exists ? "Install path exists" : `Install path missing: ${installPath}`,
    }
  },
}

const registryStep: VerifyStep = {
  name: "registry",
  verify(type, name, _installPath, ctx) {
    const entry = ctx.registry.get(type, name)
    const installed = entry?.installed === true
    return {
      step: "registry",
      passed: installed,
      message: installed ? "Registry entry found with installed=true" : "Registry entry missing or installed=false",
    }
  },
}

const lockStep: VerifyStep = {
  name: "lock",
  verify(type, name, _installPath, ctx) {
    const has = ctx.lock.has(type, name)
    return {
      step: "lock",
      passed: has,
      message: has ? "Lock entry found" : "Lock entry missing",
    }
  },
}

// ── Verifier Classes ────────────────────────────────────────────

/**
 * PostInstallVerifier — runs after install.
 * Checks: fileExists + registry(installed=true) + lock entry.
 */
export class PostInstallVerifier {
  private steps: VerifyStep[]

  constructor(extraSteps?: VerifyStep[]) {
    this.steps = [fileExistsStep, registryStep, lockStep, ...(extraSteps ?? [])]
  }

  verify(
    type: ResourceType,
    name: string,
    installPath: string,
    ctx: VerifyContext,
  ): VerifyResult {
    const results: VerifyStepResult[] = []
    for (const step of this.steps) {
      results.push(step.verify(type, name, installPath, ctx))
    }
    return {
      passed: results.every((r) => r.passed),
      steps: results,
    }
  }
}

/**
 * PostUninstallVerifier — runs after uninstall.
 * Checks: !fileExists + !registry + !lock (existence negation).
 */
export class PostUninstallVerifier {
  verify(
    type: ResourceType,
    name: string,
    installPath: string,
    ctx: VerifyContext,
  ): VerifyResult {
    const steps: VerifyStepResult[] = []

    // File should NOT exist
    const fileGone = !fs.existsSync(installPath)
    steps.push({
      step: "fileRemoved",
      passed: fileGone,
      message: fileGone ? "Install path removed" : `File still exists: ${installPath}`,
    })

    // Registry should NOT have entry
    const regGone = !ctx.registry.get(type, name)
    steps.push({
      step: "registryRemoved",
      passed: regGone,
      message: regGone ? "Registry entry removed" : "Registry entry still present",
    })

    // Lock should NOT have entry
    const lockGone = !ctx.lock.has(type, name)
    steps.push({
      step: "lockRemoved",
      passed: lockGone,
      message: lockGone ? "Lock entry removed" : "Lock entry still present",
    })

    return {
      passed: steps.every((r) => r.passed),
      steps,
    }
  }
}
