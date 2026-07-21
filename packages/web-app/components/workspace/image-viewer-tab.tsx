"use client"

import { useState, useRef, useCallback, useEffect, WheelEvent, MouseEvent } from "react"
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Download, ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getServerUrl } from "@/lib/server-config"

interface ImageViewerTabProps {
  filePath: string
  fileName: string
  workspaceId: string
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "tif", "avif", "svg",
])

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ImageViewerTab({ filePath, fileName, workspaceId }: ImageViewerTabProps) {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const imageUrl = `${getServerUrl()}/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(filePath)}`

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setImageSize({ w: img.naturalWidth, h: img.naturalHeight })
    setLoaded(true)
    setError(null)

    // Fetch file size via HEAD request
    fetch(imageUrl, { method: "HEAD" })
      .then(res => {
        const len = res.headers.get("content-length")
        if (len) setFileSize(Number(len))
      })
      .catch(() => {})
  }, [imageUrl])

  const handleError = useCallback(() => {
    setError("图片加载失败")
    setLoaded(false)
  }, [])

  // Zoom with scroll wheel
  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setScale(prev => Math.min(Math.max(prev + delta, 0.1), 10))
  }, [])

  // Pan with mouse drag
  const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    setIsDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }, [position])

  const handleMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y })
  }, [isDragging, dragStart])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Release drag on mouse leave
  useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false)
    window.addEventListener("mouseup", handleGlobalMouseUp)
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp)
  }, [])

  const resetView = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  const fitToScreen = useCallback(() => {
    if (!imageSize || !containerRef.current) return
    const container = containerRef.current.getBoundingClientRect()
    const padding = 48
    const scaleX = (container.width - padding) / imageSize.w
    const scaleY = (container.height - padding) / imageSize.h
    const newScale = Math.min(scaleX, scaleY, 1)
    setScale(newScale)
    setPosition({ x: 0, y: 0 })
  }, [imageSize])

  const zoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 10))
  }, [])

  const zoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.1))
  }, [])

  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  const isVector = ext === "svg"

  return (
    <div className="flex flex-col h-full bg-[#1a1a2e]">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border/30 bg-background/80 backdrop-blur-sm px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut} disabled={!loaded}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground min-w-[3.5rem] text-center tabular-nums">
            {loaded ? `${Math.round(scale * 100)}%` : "—"}
          </span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn} disabled={!loaded}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="w-px h-4 bg-border/40 mx-1" />

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fitToScreen} disabled={!loaded} title="适应窗口">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={resetView} disabled={!loaded} title="重置视图">
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>

        <div className="flex-1" />

        {/* Image info */}
        {loaded && imageSize && (
          <span className="text-xs text-muted-foreground">
            {imageSize.w} × {imageSize.h}
            {fileSize != null && ` · ${formatFileSize(fileSize)}`}
            {isVector && " · SVG"}
          </span>
        )}

        <div className="w-px h-4 bg-border/40 mx-1" />

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => window.open(imageUrl, "_blank")}
          disabled={!loaded}
          title="新窗口打开"
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Image canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: isDragging ? "grabbing" : loaded ? "grab" : "default" }}
      >
        {/* Checkerboard background for transparency */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(45deg, #2a2a3e 25%, transparent 25%),
              linear-gradient(-45deg, #2a2a3e 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, #2a2a3e 75%),
              linear-gradient(-45deg, transparent 75%, #2a2a3e 75%)
            `,
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
            backgroundColor: "#1e1e32",
          }}
        />

        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
            <ImageOff className="h-12 w-12 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        )}

        {/* Image */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 0.15s ease-out",
          }}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt={fileName}
            className="max-w-none"
            style={{ maxWidth: isVector ? "80%" : "none", maxHeight: isVector ? "80%" : "none" }}
            onLoad={handleImageLoad}
            onError={handleError}
            draggable={false}
          />
        </div>
      </div>
    </div>
  )
}
