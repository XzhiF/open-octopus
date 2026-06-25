#!/usr/bin/env node
/**
 * Octopus 工作流校验脚本
 *
 * 用法:
 *   node validate-workflow.js ./my-workflow.yaml
 *   node validate-workflow.js ./my-workflow.yaml --json    (JSON 输出)
 *   node validate-workflow.js ./workflows/*.yaml           (批量校验)
 *
 * 校验链:
 *   1. apiVersion 格式 (octopus/v{N})
 *   2. kind === "Workflow"
 *   3. inputs 值必须是对象而非裸字符串
 *   4. type: agent 必须有 agent 字段
 *   5. type: bash/python 必须有对应内容字段
 *   6. type: condition 必须有 cases
 *   7. type: loop 必须有 max_iterations
 *   8. 节点 id 唯一性
 *
 * 退出码: 0 = 全部通过, 1 = 存在失败
 */

const fs = require('fs')
const path = require('path')

// ── 模块解析 ───────────────────────────────────────────────────────────────────

function tryRequireYaml() {
  // 1. 直接 require — 在 bundle 版中 js-yaml 已内联，在非 bundle 版中从 node_modules 加载
  try { return require('js-yaml') } catch { /* continue */ }

  // 2. 向上走到 monorepo 根或 octopus 安装目录
  const os = require('os')
  let root = __dirname
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(root)
    if (parent === root) break
    root = parent
    if (fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ||
        (fs.existsSync(path.join(root, 'packages')) && fs.existsSync(path.join(root, 'package.json')))) {
      break
    }
  }

  // 3. 搜索候选目录
  const searchDirs = [root, process.cwd(), __dirname, os.homedir()]
  const packagesDir = path.join(root, 'packages')
  if (fs.existsSync(packagesDir)) {
    for (const p of fs.readdirSync(packagesDir)) {
      searchDirs.push(path.join(packagesDir, p))
    }
  }

  for (const d of searchDirs) {
    const p = path.join(d, 'node_modules', 'js-yaml')
    try {
      if (fs.existsSync(p)) return require(p)
    } catch { /* continue */ }
  }

  throw new Error('js-yaml not found — ensure octopus packages are installed')
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function fail(file, msg) {
  return { file, ok: false, error: msg }
}

function pass(file, info) {
  return { file, ok: true, info }
}

// ── 内联校验（不依赖 @octopus/shared）──────────────────────────────────────────

function validateInline(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')

  let yaml
  try {
    yaml = tryRequireYaml().load(content)
  } catch (e) {
    return fail(filePath, `无法加载 js-yaml: ${e.message}`)
  }

  if (!yaml || typeof yaml !== 'object') {
    return fail(filePath, 'YAML 内容为空或非对象')
  }

  // 1. apiVersion
  if (typeof yaml.apiVersion !== 'string' || !/^octopus\/v\d+$/.test(yaml.apiVersion)) {
    return fail(filePath, `apiVersion 格式错误: "${yaml.apiVersion}"，正确格式如 "octopus/v1"`)
  }

  // 2. kind
  if (yaml.kind !== 'Workflow') {
    return fail(filePath, `kind 必须为 "Workflow"，实际: "${yaml.kind}"`)
  }

  // 3. name
  if (typeof yaml.name !== 'string' || !yaml.name) {
    return fail(filePath, '缺少 name 字段')
  }

  // 4. inputs — 值必须是对象
  if (yaml.inputs && typeof yaml.inputs === 'object') {
    for (const [key, val] of Object.entries(yaml.inputs)) {
      if (val === null || typeof val !== 'object') {
        return fail(filePath, `inputs.${key} 必须是对象 { description, required?, default? }，不能是裸值`)
      }
      if (typeof val.description !== 'string') {
        return fail(filePath, `inputs.${key} 缺少必填的 description 字段`)
      }
    }
  }

  // 5. nodes
  if (!Array.isArray(yaml.nodes) || yaml.nodes.length === 0) {
    return fail(filePath, 'nodes 必须是非空数组')
  }

  const ids = new Set()
  const collectIds = (nodes) => {
    for (const n of nodes) {
      if (!n.id || typeof n.id !== 'string') {
        return fail(filePath, '每个节点必须有 id 字段')
      }
      if (ids.has(n.id)) {
        return fail(filePath, `节点 id "${n.id}" 重复`)
      }
      ids.add(n.id)
      if (n.nodes) collectIds(n.nodes)
    }
  }
  const dupErr = collectIds(yaml.nodes)
  if (dupErr) return dupErr

  const validateNode = (n) => {
    switch (n.type) {
      case 'bash':
        if (!n.bash) return fail(filePath, `节点 "${n.id}": type=bash 必须有 bash 字段`)
        break
      case 'python':
        if (!n.python) return fail(filePath, `节点 "${n.id}": type=python 必须有 python 字段`)
        break
      case 'agent':
        if (!n.agent && !n.prompt && !n.agents) return fail(filePath, `节点 "${n.id}": type=agent 必须有 agent、prompt 或 agents 字段`)
        break
      case 'condition':
        if (!n.cases || n.cases.length === 0)
          return fail(filePath, `节点 "${n.id}": type=condition 必须有 cases 字段`)
        break
      case 'loop':
        if (!n.max_iterations)
          return fail(filePath, `节点 "${n.id}": type=loop 必须有 max_iterations 字段`)
        if (n.nodes) {
          for (const inner of n.nodes) {
            const err = validateNode(inner)
            if (err) return err
          }
        }
        break
      case 'approval':
        break
      default:
        return fail(filePath, `节点 "${n.id}": 未知类型 "${n.type}"`)
    }
  }

  for (const node of yaml.nodes) {
    const err = validateNode(node)
    if (err) return err
  }

  const inputCount = yaml.inputs ? Object.keys(yaml.inputs).length : 0
  return pass(filePath, `${yaml.name}: ${yaml.nodes.length} nodes, ${inputCount} inputs`)
}

// ── 完整校验（使用 @octopus/shared）────────────────────────────────────────────

function validateFull(filePath) {
  let shared
  try {
    shared = require('@octopus/shared')
  } catch {
    return null // fallback to inline
  }

  const content = fs.readFileSync(filePath, 'utf-8')

  if (!shared.isOctopusWorkflow(content)) {
    return fail(filePath, '不是有效的 Octopus 工作流 (apiVersion/kind 不符)')
  }

  let parsed
  try {
    parsed = shared.parseWorkflow(content)
  } catch (e) {
    return fail(filePath, e.message)
  }

  try {
    shared.validateWorkflow(parsed)
  } catch (e) {
    return fail(filePath, e.message)
  }

  const inputCount = parsed.inputs ? Object.keys(parsed.inputs).length : 0
  return pass(filePath, `${parsed.name}: ${parsed.nodes.length} nodes, ${inputCount} inputs`)
}

// ── 主入口 ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const files = args.filter(a => !a.startsWith('--'))

  if (files.length === 0) {
    console.error('用法: node validate-workflow.js <yaml-file> [--json]')
    process.exit(2)
  }

  // glob 展开
  const allFiles = []
  for (const f of files) {
    if (f.includes('*')) {
      const { globSync } = require('glob') || {}
      if (globSync) {
        allFiles.push(...globSync(f))
      } else {
        // 简单通配符展开
        const dir = path.dirname(f)
        const pat = path.basename(f).replace(/\*/g, '(.*)')
        if (fs.existsSync(dir)) {
          const regex = new RegExp('^' + pat + '$')
          allFiles.push(...fs.readdirSync(dir).filter(fn => regex.test(fn)).map(fn => path.join(dir, fn)))
        }
      }
    } else {
      if (!fs.existsSync(f)) {
        console.error(`文件不存在: ${f}`)
        continue
      }
      allFiles.push(f)
    }
  }

  const results = []
  for (const f of allFiles) {
    if (f !== '/dev/stdin' && !f.endsWith('.yaml') && !f.endsWith('.yml')) continue

    // 优先用完整校验
    let result = validateFull(f)
    if (result === null) {
      result = validateInline(f)
    }
    results.push(result)
  }

  // 输出
  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    let passed = 0
    let failed = 0
    for (const r of results) {
      if (r.ok) {
        console.log(`✓ ${r.file}`)
        console.log(`  ${r.info}`)
        passed++
      } else {
        console.log(`✗ ${r.file}`)
        console.log(`  ${r.error}`)
        failed++
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`)

    if (failed > 0) process.exit(1)
  }
}

main()