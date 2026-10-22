import { ResourceLayout } from '@/components/resource/resource-layout'
import ResourceDetailPage from '@/app/resources/[type]/[name]/page'

export default function ResourceDetailRoute() {
  return (
    <ResourceLayout>
      <ResourceDetailPage />
    </ResourceLayout>
  )
}
