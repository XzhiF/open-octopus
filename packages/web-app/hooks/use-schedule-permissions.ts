"use client"

import type { SchedulePermissions } from "@/lib/types"

const ALL_PERMISSIONS: SchedulePermissions = {
  canCreate: true,
  canEdit: true,
  canDelete: true,
  canEnableDisable: true,
  canTrigger: true,
  canEmergencyStop: true,
  canViewAuditLogs: true,
}

/** V1 simplified: always returns full permissions. */
export function useSchedulePermissions(_wsId: string): SchedulePermissions {
  return ALL_PERMISSIONS
}
