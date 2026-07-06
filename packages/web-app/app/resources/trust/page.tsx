import { redirect } from "next/navigation"

export default function TrustPage() {
  redirect("/resources?tab=trust")
}
