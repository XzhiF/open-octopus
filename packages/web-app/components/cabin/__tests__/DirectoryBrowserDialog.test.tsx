// 建舱目录选择窗：新建文件夹（2026-11-16 用户要求）——
// 选目录时能建目录，建完直接落进去，再点「选择当前目录」。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { browseDirectories, createDirectory } = vi.hoisted(() => ({
  browseDirectories: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, browseDirectories, createDirectory }
})

import { DirectoryBrowserDialog } from '../DirectoryBrowserDialog'

const homeBrowse = {
  path: '/home/u',
  parent: '/home',
  home: '/home/u',
  roots: [{ name: '/', path: '/' }],
  dirs: [{ name: 'projects', path: '/home/u/projects' }],
  canSelect: true,
}

beforeEach(() => {
  browseDirectories.mockReset().mockResolvedValue(homeBrowse)
  createDirectory.mockReset()
})

function renderDialog(onPick = vi.fn()) {
  render(
    <DirectoryBrowserDialog
      open
      initialPath="/home/u"
      lockedPaths={new Map()}
      onPick={onPick}
      onOpenCabin={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return onPick
}

describe('DirectoryBrowserDialog — 新建文件夹', () => {
  it('建完落进新目录，选中回传新路径', async () => {
    createDirectory.mockResolvedValue({
      path: '/home/u/aurora',
      browse: { ...homeBrowse, path: '/home/u/aurora', parent: '/home/u', dirs: [] },
    })
    const onPick = renderDialog()
    await waitFor(() => expect(screen.getByTestId('cabin-dir-path')).toHaveTextContent('/home/u'))

    fireEvent.click(screen.getByTestId('cabin-dir-mkdir-open'))
    fireEvent.change(screen.getByTestId('cabin-dir-mkdir-input'), { target: { value: 'aurora' } })
    fireEvent.click(screen.getByTestId('cabin-dir-mkdir-ok'))

    await waitFor(() => expect(createDirectory).toHaveBeenCalledWith('/home/u', 'aurora'))
    await waitFor(() => expect(screen.getByTestId('cabin-dir-path')).toHaveTextContent('/home/u/aurora'))
    fireEvent.click(screen.getByTestId('cabin-dir-pick'))
    expect(onPick).toHaveBeenCalledWith('/home/u/aurora')
  })

  it('重名/非法名字 → 错误留在行内，目录不变', async () => {
    createDirectory.mockRejectedValue(new Error('同名文件或文件夹已存在: aurora'))
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('cabin-dir-path')).toHaveTextContent('/home/u'))

    fireEvent.click(screen.getByTestId('cabin-dir-mkdir-open'))
    fireEvent.change(screen.getByTestId('cabin-dir-mkdir-input'), { target: { value: 'aurora' } })
    fireEvent.click(screen.getByTestId('cabin-dir-mkdir-ok'))

    expect(await screen.findByTestId('cabin-dir-mkdir-error')).toHaveTextContent('已存在')
    expect(screen.getByTestId('cabin-dir-path')).toHaveTextContent('/home/u')
  })
})
