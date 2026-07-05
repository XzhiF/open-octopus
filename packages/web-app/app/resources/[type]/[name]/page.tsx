"use client"

import { ResourceDetail } from "@/components/resources/resource-detail"

interface Props {
  params: Promise<{ type: string; name: string }>
}

export default async function ResourceDetailPage({ params }: Props) {
  const { type, name } = await params

  return <ResourceDetail type={type} name={name} />
}
