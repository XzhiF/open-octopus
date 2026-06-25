# Knowledge Reference Skill Template

## Overview [REQUIRED]
Describe the knowledge domain this Skill provides.
Include trigger conditions — when should the Agent use this Skill?

## Prerequisites [OPTIONAL]
Required access, tools, and permissions for querying data sources.
<!-- Environment variables will be injected here if selected -->

## MCP Tools [OPTIONAL]
Available MCP tools for querying data.
<!-- MCP configurations will be injected here if selected -->

## Data Sources [REQUIRED]
List available data sources and their coverage.
- Source 1: {name} — {what it covers, freshness, limitations}
- Source 2: {name} — {what it covers, freshness, limitations}

## Query Patterns [REQUIRED]
### Pattern 1: {Query Type}
- Input: What the user provides
- Processing: How the Skill finds the answer
- Output: What the Skill returns

### Pattern 2: {Query Type}
- Input: What the user provides
- Processing: How the Skill finds the answer
- Output: What the Skill returns

## Accuracy Notes [OPTIONAL]
- Data freshness and update frequency
- Known limitations and coverage gaps
- Conflicting source handling rules

## Knowledge Sources [OPTIONAL]
<!-- - {project} ({group}/{name}) — {what was referenced} -->
<!-- 源码定位: ~/.octopus/repos/index.md | 不可达 → index.md存在: repos clone | 不存在: 请用户告知路径或替代信息 -->

## Escalation [OPTIONAL]
- When data is unavailable or insufficient
- Who to contact for specialized knowledge

## Version History
- v1.0.0 ({date}): Initial release