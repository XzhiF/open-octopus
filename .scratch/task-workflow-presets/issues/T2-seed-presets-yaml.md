# T2 — core-pack: workflow-presets.yaml seed file

## Status: done

## Depends on: none

## Scope

Create a default preset catalog YAML at `packages/core-pack/presets/workflow-presets.yaml`:

```yaml
# Default workflow presets — maps skill groups to recommended workflows + input templates.
# Each preset: name + skills_group[] (empty = general fallback) + workflow ref + inputs skeleton.
# Inputs may contain ${goal} and ${ac} placeholders — resolved at materialization time.
presets:
  - name: general-dev
    skills_group: []
    workflow: built-in/matt-dev-pipeline
    inputs:
      requirement: "${goal}"
      acceptance_criteria: "${ac}"

  - name: xzf-dev
    skills_group: [octo-xzf-implementer]
    workflow: built-in/xzf-dev
    inputs:
      requirement: "${goal}"
      acceptance_criteria: "${ac}"
```

Also ensure the file exists at `~/.octopus/agent/built-in/task-author/workflow-presets.yaml` (seed it if not present).

## Verification

- File exists and is valid YAML
- `yaml.parse(content)` succeeds
- Presets array has at least 1 entry with required fields
