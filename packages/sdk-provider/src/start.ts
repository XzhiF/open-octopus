import { createServer } from './server'
import { buildToolManifest } from './tools'

const port = Number(process.env.PORT) || 3200
const tools = buildToolManifest()
const server = createServer()

server.listen(port, () => {
  console.log(`[sdk-provider] Baidu Map Agent listening on http://localhost:${port}`)
  console.log(`[sdk-provider] Tools: ${tools.map((t) => t.name).join(', ')}`)
})
