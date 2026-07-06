"use client"

import { createContext, useContext } from "react"

/**
 * ResourceContext — provides shared org context to resource components.
 * Eliminates hardcoded DEFAULT_ORG duplication (HC3 fix).
 */

const DEFAULT_ORG = "default"

interface ResourceContextValue {
  org: string
}

const ResourceContext = createContext<ResourceContextValue>({
  org: DEFAULT_ORG,
})

export function ResourceProvider({
  org = DEFAULT_ORG,
  children,
}: {
  org?: string
  children: React.ReactNode
}) {
  return (
    <ResourceContext.Provider value={{ org }}>
      {children}
    </ResourceContext.Provider>
  )
}

export function useResourceOrg(): string {
  return useContext(ResourceContext).org
}
