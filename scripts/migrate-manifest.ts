#!/usr/bin/env node
/**
 * Migrate manifest.md to manifest.json for a given org.
 *
 * Usage: npx tsx scripts/migrate-manifest.ts <org>
 *   or:  node dist/scripts/migrate-manifest.js <org>
 *
 * This script:
 * 1. Reads ~/.octopus/orgs/<org>/repos/manifest.md
 * 2. Parses all entries using the markdown parser
 * 3. Writes manifest.json using the JSON format
 * 4. Verifies record count matches
 * 5. Outputs a migration report
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parseManifest, writeManifestJson } from "../packages/shared/src/repo-ops/mod"

function main() {
  const org = process.argv[2]
  if (!org) {
    console.error("Usage: migrate-manifest <org>")
    console.error("Example: migrate-manifest xzf")
    process.exit(1)
  }

  const globalDir = process.env.OCTOPUS_HOME ?? join(homedir(), ".octopus")
  const orgDir = join(globalDir, "orgs", org)
  const reposDir = join(orgDir, "repos")
  const mdPath = join(reposDir, "manifest.md")
  const jsonPath = join(reposDir, "manifest.json")

  // Check source file exists
  if (!existsSync(mdPath)) {
    console.error(`Error: manifest.md not found at ${mdPath}`)
    console.error(`Run 'octopus setup --org ${org}' first.`)
    process.exit(1)
  }

  // Check if already migrated
  if (existsSync(jsonPath)) {
    console.warn(`Warning: manifest.json already exists at ${jsonPath}`)
    console.warn("Skipping migration to avoid overwriting existing data.")
    console.warn("Delete manifest.json first if you want to re-run migration.")
    process.exit(0)
  }

  console.log(`Migrating manifest for org: ${org}`)
  console.log(`  Source: ${mdPath}`)
  console.log(`  Target: ${jsonPath}`)
  console.log()

  // Read and parse markdown
  const mdContent = readFileSync(mdPath, "utf-8")
  let groups
  try {
    groups = parseManifest(mdContent)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error parsing manifest.md: ${msg}`)
    process.exit(1)
  }

  // Count records
  let totalRecords = 0
  let totalGroups = 0
  const report: Array<{ group: string; count: number }> = []

  for (const [groupName, entries] of Object.entries(groups)) {
    totalGroups++
    totalRecords += entries.length
    report.push({ group: groupName, count: entries.length })
  }

  // Write JSON
  try {
    const jsonContent = writeManifestJson(groups)
    writeFileSync(jsonPath, jsonContent, "utf-8")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error writing manifest.json: ${msg}`)
    process.exit(1)
  }

  // Verify: re-read JSON and compare counts
  let verifyGroups
  try {
    const jsonContent = readFileSync(jsonPath, "utf-8")
    // Dynamic import to avoid circular dependency issues
    const { parseManifestJson } = require("../packages/shared/src/repo-ops/mod")
    verifyGroups = parseManifestJson(jsonContent)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error verifying manifest.json: ${msg}`)
    process.exit(1)
  }

  let verifyCount = 0
  for (const entries of Object.values(verifyGroups)) {
    verifyCount += (entries as unknown[]).length
  }

  // Output report
  console.log("Migration Report:")
  console.log("─".repeat(40))
  for (const { group, count } of report) {
    console.log(`  ${group}: ${count} repos`)
  }
  console.log("─".repeat(40))
  console.log(`  Total: ${totalRecords} repos in ${totalGroups} groups`)
  console.log()

  if (verifyCount !== totalRecords) {
    console.error(`ERROR: Record count mismatch! MD=${totalRecords}, JSON=${verifyCount}`)
    process.exit(1)
  }

  console.log(`Migration successful: ${totalRecords} records migrated.`)
  console.log()
  console.log("Next steps:")
  console.log(`  1. Verify manifest.json looks correct: cat ${jsonPath}`)
  console.log(`  2. Delete manifest.md when ready: rm ${mdPath}`)
  console.log(`  3. Test CLI: octopus repos list --org ${org}`)
}

main()
