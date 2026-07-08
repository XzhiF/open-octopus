import { redirect } from "next/navigation"

export default function AuditPage() {
  redirect("/resources?tab=audit")
}
