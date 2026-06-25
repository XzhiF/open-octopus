// Deterministic branch color assignment — same branch name always maps to the same color.

export interface BranchColor {
  bg: string
  text: string
  border: string
  hex: string
  name: string
}

const palette: BranchColor[] = [
  { bg: "bg-cyan-100", text: "text-cyan-700", border: "border-cyan-300", hex: "#0891b2", name: "cyan" },
  { bg: "bg-indigo-100", text: "text-indigo-700", border: "border-indigo-300", hex: "#4f46e5", name: "indigo" },
  { bg: "bg-fuchsia-100", text: "text-fuchsia-700", border: "border-fuchsia-300", hex: "#c026d3", name: "fuchsia" },
  { bg: "bg-lime-100", text: "text-lime-700", border: "border-lime-300", hex: "#65a30d", name: "lime" },
  { bg: "bg-pink-100", text: "text-pink-700", border: "border-pink-300", hex: "#db2777", name: "pink" },
  { bg: "bg-amber-100", text: "text-amber-700", border: "border-amber-300", hex: "#d97706", name: "amber" },
  { bg: "bg-sky-100", text: "text-sky-700", border: "border-sky-300", hex: "#0284c7", name: "sky" },
  { bg: "bg-teal-100", text: "text-teal-700", border: "border-teal-300", hex: "#0d9488", name: "teal" },
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function getBranchColor(branchName: string): BranchColor {
  return palette[hashString(branchName) % palette.length]
}