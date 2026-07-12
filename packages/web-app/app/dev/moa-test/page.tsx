// packages/web-app/app/dev/moa-test/page.tsx
"use client"

import { MoaConfigPanel } from "@/components/swarm/organisms/moa-config-panel"
import { MoaResultTab } from "@/components/swarm/organisms/moa-result-tab"
import { ModelResolveBadge } from "@/components/swarm/atoms/model-resolve-badge"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ExpertInfo } from "@/lib/swarm-types"

const MOCK_TIER_MAP = {
  pi: {
    "pro-max": "pi-pro-max-v2",
    "pro": "pi-pro-v1",
    "se": "pi-se-v1",
  },
}

const MOCK_EXPERTS_SUCCESS: ExpertInfo[] = [
  { role: "security", status: "completed", model: "pi-pro-max-v2", source: "predefined", tokensConsumed: 1200, inputTokens: 800, outputTokens: 400, output: "## Security Review\n\n1. SQL injection vulnerability in user input handler\n2. Missing CSRF protection on form endpoints\n3. Hardcoded API keys in configuration\n\nRecommendations: Use parameterized queries, add CSRF middleware, move secrets to env vars.", attempts: 1 },
  { role: "performance", status: "completed", model: "pi-pro-v1", source: "predefined", tokensConsumed: 900, inputTokens: 600, outputTokens: 300, output: "## Performance Analysis\n\n1. N+1 query pattern in user list endpoint\n2. Missing database index on created_at column\n3. Large JSON payloads without compression\n\nRecommendations: Add eager loading, create composite index, enable gzip.", attempts: 1 },
  { role: "maintainability", status: "completed", model: "pi-se-v1", source: "predefined", tokensConsumed: 800, inputTokens: 500, outputTokens: 300, output: "## Maintainability Report\n\n1. Long functions (>50 lines) in 3 files\n2. Missing type annotations in utility module\n3. Inconsistent error handling patterns\n\nRecommendations: Extract helper functions, add explicit types, standardize error classes.", attempts: 1 },
]

const MOCK_EXPERTS_PARTIAL: ExpertInfo[] = [
  { role: "security", status: "completed", model: "pi-pro-max-v2", source: "predefined", tokensConsumed: 1200, inputTokens: 800, outputTokens: 400, output: "Security review completed successfully.", attempts: 1 },
  { role: "performance", status: "failed", model: "pi-pro-v1", source: "predefined", tokensConsumed: 0, inputTokens: 0, outputTokens: 0, output: "", error: "Expert performance timeout after 120000ms", attempts: 1 },
]

const MOCK_EXPERTS_ALL_FAILED: ExpertInfo[] = [
  { role: "security", status: "failed", model: "pi-pro-max-v2", source: "predefined", tokensConsumed: 0, inputTokens: 0, outputTokens: 0, output: "", error: "Model API rate limit exceeded", attempts: 1 },
  { role: "performance", status: "failed", model: "pi-pro-v1", source: "predefined", tokensConsumed: 0, inputTokens: 0, outputTokens: 0, output: "", error: "Expert performance timeout after 120000ms", attempts: 1 },
]

const MOCK_MOA_RESULTS = [
  { role: "security", model: "pi-pro-max-v2", status: "completed" as const, outputPreview: "SQL injection vulnerability found...", durationMs: 2100, degraded: false },
  { role: "performance", model: "pi-pro-v1", status: "completed" as const, outputPreview: "N+1 query pattern detected...", durationMs: 1800, degraded: true, degradationChain: ["pro-max-performance", "pro-max", "pro"] },
  { role: "maintainability", model: "pi-se-v1", status: "completed" as const, outputPreview: "Long functions detected...", durationMs: 1500, degraded: false },
]

export default function MoaTestPage() {
  // M4 fix: don't ship dev test page in production builds
  if (process.env.NODE_ENV === "production") return null

  return (
    <TooltipProvider>
      <div className="p-6 space-y-8 max-w-[1200px] mx-auto">
        <h1 data-testid="moa-test-title" className="text-2xl font-bold">
          MOA Swarm Mode — Test Page
        </h1>

        {/* TC-016/017: Config Panel */}
        <section data-testid="tc-moa-config" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-016/017: MoaConfigPanel</h2>
          <div className="rounded-lg border p-4" style={{ height: "600px" }}>
            <MoaConfigPanel
              workspaceId="test-workspace"
              onSave={() => {}}
              onCancel={() => {}}
            />
          </div>
        </section>

        {/* TC-018: Model Resolve Badges */}
        <section data-testid="tc-moa-badges" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-018: ModelResolveBadge</h2>
          <div className="rounded-lg border p-4 flex gap-4 flex-wrap items-center">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Exact match</p>
              <ModelResolveBadge modelId="pro-max" providerType="pi" tierMap={MOCK_TIER_MAP} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Degraded match</p>
              <ModelResolveBadge modelId="pro-max-custom" providerType="pi" tierMap={MOCK_TIER_MAP} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Error</p>
              <ModelResolveBadge modelId="nonexistent-model" providerType="unknown" tierMap={MOCK_TIER_MAP} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Empty (hidden)</p>
              <ModelResolveBadge modelId="" providerType="pi" tierMap={MOCK_TIER_MAP} />
            </div>
          </div>
        </section>

        {/* TC-021: Result — empty */}
        <section data-testid="tc-moa-result" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-021: MoaResultTab — Empty</h2>
          <div className="rounded-lg border p-4">
            <MoaResultTab
              status="initializing"
              experts={[]}
              moaExpertResults={[]}
              aggregatorStatus="idle"
              aggregatorRound={0}
              aggregatorTotalRounds={0}
              aggregatorModel=""
              aggregatorInputExpertCount={0}
              hostReport={null}
            />
          </div>
        </section>

        {/* TC-021/023/028: Result — success */}
        <section data-testid="tc-moa-result-success" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-021: MoaResultTab — Success</h2>
          <div className="rounded-lg border p-4">
            <MoaResultTab
              status="completed"
              experts={MOCK_EXPERTS_SUCCESS}
              moaExpertResults={MOCK_MOA_RESULTS}
              aggregatorStatus="completed"
              aggregatorRound={1}
              aggregatorTotalRounds={1}
              aggregatorModel="pi-pro-max-v2"
              aggregatorInputExpertCount={3}
              hostReport="## Aggregated Synthesis\n\nBased on 3 expert reviews:\n1. Security: 3 vulnerabilities found\n2. Performance: 3 optimization opportunities\n3. Maintainability: 3 code quality issues\n\nPriority: Fix SQL injection and N+1 queries first."
            />
          </div>
        </section>

        {/* TC-022: Result — partial failure */}
        <section data-testid="tc-moa-result-partial" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-022: MoaResultTab — Partial Failure</h2>
          <div className="rounded-lg border p-4">
            <MoaResultTab
              status="completed"
              experts={MOCK_EXPERTS_PARTIAL}
              moaExpertResults={[
                { role: "security", model: "pi-pro-max-v2", status: "completed" as const, outputPreview: "Success", durationMs: 2100, degraded: false },
                { role: "performance", model: "pi-pro-v1", status: "failed" as const, outputPreview: "", durationMs: 120000, degraded: false },
              ]}
              aggregatorStatus="completed"
              aggregatorRound={1}
              aggregatorTotalRounds={1}
              aggregatorModel="pi-pro-max-v2"
              aggregatorInputExpertCount={1}
              hostReport="Partial synthesis from 1 expert."
            />
          </div>
        </section>

        {/* TC-015: Result — all failed */}
        <section data-testid="tc-moa-result-all-failed" className="space-y-2">
          <h2 className="text-lg font-semibold">TC-015: MoaResultTab — All Failed</h2>
          <div className="rounded-lg border p-4">
            <MoaResultTab
              status="failed"
              experts={MOCK_EXPERTS_ALL_FAILED}
              moaExpertResults={[
                { role: "security", model: "pi-pro-max-v2", status: "failed" as const, outputPreview: "", durationMs: 5000, degraded: false },
                { role: "performance", model: "pi-pro-v1", status: "failed" as const, outputPreview: "", durationMs: 120000, degraded: false },
              ]}
              aggregatorStatus="idle"
              aggregatorRound={0}
              aggregatorTotalRounds={0}
              aggregatorModel=""
              aggregatorInputExpertCount={0}
              hostReport={null}
              onRetry={() => alert("Retry clicked")}
            />
          </div>
        </section>
      </div>
    </TooltipProvider>
  )
}
