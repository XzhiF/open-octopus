// packages/web-app/components/scheduler/__tests__/project-selector.test.tsx
//
// Exercises the REAL ProjectSelector (other suites mock it). Focus: the
// restored-selection echo (bugfix 2026-08-26) — task.project_ids persists only
// NAMES, so a reloaded preset popup gets SelectedProject entries with group == ""
// and `${group}/${name}` used to match nothing against the manifest, leaving the
// previously-chosen checkboxes unchecked. ProjectSelector must resolve the
// missing group from the loaded manifest for display/matching.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { ProjectSelector } from "../project-selector"

vi.mock("@/lib/api-client", () => ({
  fetchManifestRepos: vi.fn(),
}))

import { fetchManifestRepos } from "@/lib/api-client"

const mockFetchManifestRepos = vi.mocked(fetchManifestRepos)

const MANIFEST = {
  groups: {
    "octo": [
      { name: "octopus-server", git_url: "git@github.com:octopus/server.git", branch: "main" },
      { name: "octopus-engine", git_url: "git@github.com:octopus/engine.git", branch: "main" },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchManifestRepos.mockResolvedValue(MANIFEST)
})

describe("ProjectSelector — restored-selection echo (bugfix)", () => {
  it("checks the manifest checkbox of a project restored from project_ids (group unknown)", async () => {
    const onChange = vi.fn()
    render(
      <ProjectSelector
        org="E2E_TD_org"
        value={[{ name: "octopus-server", source_path: "", group: "" }]}
        onChange={onChange}
      />,
    )

    // Once the manifest loads, the restored project resolves its group and the
    // matching checkbox reflects as checked.
    await waitFor(() => {
      const cb = screen.getByRole("checkbox", { name: /octopus-server/ })
      expect(cb.getAttribute("aria-checked")).toBe("true")
    })

    // Group resolution is display-only — loading the manifest must not mutate
    // the parent's controlled state (locked popup passes a no-op onChange).
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows the resolved group in the selected-project badge (was \"/name\" before)", async () => {
    render(
      <ProjectSelector
        org="E2E_TD_org"
        value={[{ name: "octopus-engine", source_path: "", group: "" }]}
        onChange={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText("octo/octopus-engine")).toBeDefined()
    })
  })

  it("leaves a group-bearing selected project untouched (no regression for live picks)", async () => {
    const onChange = vi.fn()
    render(
      <ProjectSelector
        org="E2E_TD_org"
        value={[{ name: "octopus-server", source_path: "", group: "octo" }]}
        onChange={onChange}
      />,
    )

    await waitFor(() => {
      const cb = screen.getByRole("checkbox", { name: /octopus-server/ })
      expect(cb.getAttribute("aria-checked")).toBe("true")
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})