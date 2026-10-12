import { dirname } from "path"
import { fileURLToPath } from "url"
import { FlatCompat } from "@eslint/eslintrc"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends("next/core-web-vitals"),
  {
    ignores: [".next/**", "out/**", "node_modules/**"],
  },
  {
    rules: {
      // 历史 JSX 裸引号 15 处先降 warn 让 CI 闸能上（retro①），warn 计数继续可见；
      // 清零后可移除此覆盖回 error。
      "react/no-unescaped-entities": "warn",
    },
  },
]

export default eslintConfig
