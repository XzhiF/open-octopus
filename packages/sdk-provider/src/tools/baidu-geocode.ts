import { z } from 'zod'
import https from 'node:https'

import type { ToolDefinition } from '../types'

const inputSchema = z.object({
  address: z.string().min(1, 'address is required'),
  city: z.string().optional(),
})

type GeocodeInput = z.infer<typeof inputSchema>

interface GeocodeResult {
  address: string
  location: { lat: number; lng: number }
  confidence: number
  level: string
}

interface BaiduGeocodeResponse {
  status: number
  result: {
    location: { lng: number; lat: number }
    confidence: number
    comprehension?: number
    level: string
  }
}

function fetchGeocode(address: string, city: string | undefined, ak: string): Promise<BaiduGeocodeResponse> {
  const params = new URLSearchParams({
    address,
    output: 'json',
    ak,
    ...(city ? { city } : {}),
  })

  const url = `https://api.map.baidu.com/geocoding/v2/?${params}`

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as BaiduGeocodeResponse)
        } catch {
          reject(new Error(`Invalid JSON response from Baidu API: ${data.slice(0, 200)}`))
        }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

export const baiduGeocodeTool: ToolDefinition = {
  name: 'baidu_geocode',
  description: '将地址转换为经纬度坐标（百度地图地理编码 API v2）。输入地址文本，返回经纬度和置信度。',
  inputSchema,
  async execute(input: GeocodeInput): Promise<GeocodeResult> {
    const ak = process.env.BAIDU_MAP_AK
    if (!ak) {
      throw new Error('BAIDU_MAP_AK environment variable is not set. Obtain one at https://lbsyun.baidu.com/apiconsole/key')
    }

    const response = await fetchGeocode(input.address, input.city, ak)

    if (response.status !== 0) {
      throw new Error(`Baidu Geocoding API error: status=${response.status}`)
    }

    return {
      address: input.address,
      location: response.result.location,
      confidence: response.result.confidence,
      level: response.result.level,
    }
  },
}
