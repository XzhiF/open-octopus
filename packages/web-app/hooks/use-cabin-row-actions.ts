'use client'

// 左栏作战舱行「⋯」的两个动作（2026-11-15 用户要求，跟任务行同一套手感）。
// 桌面普通对话与舱内左栏是同一个 ChatSidebar，但宿主不同：一个只有列表，
// 一个还有「当前舱」。所以写库和刷新列表放这里，跳转/刷新当前舱交给宿主回调。

import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  deleteCabin, getCabin, patchCabin, type CabinDetail,
} from '@/lib/cabin-api'

export interface CabinRowActionsOptions {
  /** 刷左栏列表（useCabins().refresh）。 */
  refresh: () => Promise<void> | void
  /** 改名成功之后（舱内宿主用它刷新当前舱的舱头 / 门禁卡）。 */
  onRenamed?: (cabin: CabinDetail) => void
  /** 删除成功之后（舱内宿主用它离开已经不存在的舱）。 */
  onDeleted?: (cabin: CabinDetail) => void
}

export interface CabinRowActions {
  renameCabin: (cabin: CabinDetail, name: string) => Promise<void>
  /** 软删除；`deleteFiles` = 确认弹框里勾了「同时删除本地文件」。 */
  deleteCabinRow: (cabin: CabinDetail, opts: { deleteFiles: boolean }) => Promise<void>
}

export function useCabinRowActions({
  refresh, onRenamed, onDeleted,
}: CabinRowActionsOptions): CabinRowActions {
  const renameCabin = useCallback(async (cabin: CabinDetail, name: string) => {
    // 列表里的 version 可能停在 30s 前；先取最新的再乐观锁更新（同任务重命名）。
    const fresh = await getCabin(cabin.id)
    const updated = await patchCabin(cabin.id, fresh.cabin.version, { name })
    await refresh()
    onRenamed?.(updated)
  }, [refresh, onRenamed])

  const deleteCabinRow = useCallback(async (cabin: CabinDetail, opts: { deleteFiles: boolean }) => {
    const result = await deleteCabin(cabin.id, opts)
    await refresh()
    if (opts.deleteFiles && !result.deleted_files) {
      // 勾了要删文件却没删掉（路径受保护 / 没权限）—— 不能静默。
      toast.warning('舱已删除，但本地目录没能删掉（路径受保护或没有权限）')
    }
    onDeleted?.(cabin)
  }, [refresh, onDeleted])

  return { renameCabin, deleteCabinRow }
}