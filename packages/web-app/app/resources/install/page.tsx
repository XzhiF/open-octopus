"use client"

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { InstallDialog } from "@/components/resource/install-dialog"

export default function InstallPage() {
  const router = useRouter()

  return (
    <InstallDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) router.push("/resources")
      }}
    />
  )
}
