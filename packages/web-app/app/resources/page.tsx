"use client"

import { useResources } from "@/hooks/use-resources"
import { ResourceGrid, ResourceGridSkeleton } from "@/components/resource/resource-grid"
import { FilterTabs } from "@/components/resource/filter-tabs"
import { SearchBar } from "@/components/resource/search-bar"
import { InstallDialog } from "@/components/resource/install-dialog"
import { DriftList } from "@/components/resource/drift-list"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia } from "@/components/ui/empty"
import { Package, SearchX, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function ResourcesPage() {
  const { data, total, loading, error, refetch, type, query, setTypeFilter, setQuery } = useResources()

  return (
    <div className="container mx-auto px-4 py-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">资源管理</h1>
          <p className="text-sm text-muted-foreground">
            管理 skill、agent 和 workflow 资源
          </p>
        </div>
        <InstallDialog onSuccess={refetch} />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterTabs value={type} onChange={setTypeFilter} />
        <div className="w-full sm:w-64">
          <SearchBar value={query} onChange={setQuery} />
        </div>
      </div>

      {/* Content */}
      {loading && <ResourceGridSkeleton />}

      {error && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircle className="text-destructive" />
            </EmptyMedia>
            <EmptyTitle>加载失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={refetch}>重试</Button>
          </EmptyContent>
        </Empty>
      )}

      {!loading && !error && data.length === 0 && !type && !query && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Package />
            </EmptyMedia>
            <EmptyTitle>暂无资源</EmptyTitle>
            <EmptyDescription>
              点击右上角「安装资源」按钮，通过引用安装 skill、agent 或 workflow
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <InstallDialog onSuccess={refetch} />
          </EmptyContent>
        </Empty>
      )}

      {!loading && !error && data.length === 0 && (type || query) && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>无匹配结果</EmptyTitle>
            <EmptyDescription>
              {query ? `没有找到包含「${query}」的资源` : `没有 ${type} 类型的资源`}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => { setTypeFilter(undefined); setQuery("") }}>
              清除过滤
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {!loading && !error && data.length > 0 && (
        <>
          <div className="text-sm text-muted-foreground">
            共 {total} 个资源
          </div>
          <ResourceGrid resources={data} />
        </>
      )}

      {/* Drift Detection */}
      {!loading && !error && <DriftList />}
    </div>
  )
}
