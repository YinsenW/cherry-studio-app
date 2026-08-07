import { tool } from 'ai'
import { z } from 'zod'

/**
 * 免费公共 API 工具（无需 key，BYOK 零成本）。
 * - 天气：Open-Meteo（无 key，7 日预报）
 * - 汇率：open.er-api.com（无 key，实时）
 */

const WEATHER_BASE = 'https://api.open-meteo.com/v1/forecast'

export const getWeather = tool({
  description:
    'Get current weather and a short forecast for a location (by latitude/longitude or city name). Returns temperature, condition, wind, and daily forecast. Free API, no key needed.',
  inputSchema: z.object({
    latitude: z.number().optional().describe('Latitude, e.g. 39.9042 for Beijing. Provide with longitude.'),
    longitude: z.number().optional().describe('Longitude, e.g. 116.4074 for Beijing.'),
    city: z
      .string()
      .optional()
      .describe('City name (e.g. "Beijing", "Tokyo"). If provided, latitude/longitude are ignored.'),
    days: z.number().optional().describe('Days of forecast, default 3, max 7')
  }),
  execute: async ({ latitude, longitude, city, days }) => {
    let lat: number | undefined = latitude
    let lon: number | undefined = longitude

    if (city) {
      try {
        // 用 Open-Meteo 的地理编码解析城市名
        const geocoding = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`
        ).then(r => r.json())
        if (geocoding.results?.length > 0) {
          lat = geocoding.results[0].latitude
          lon = geocoding.results[0].longitude
        } else {
          return { ok: false, error: `City "${city}" not found` }
        }
      } catch (e) {
        return { ok: false, error: `Failed to geocode "${city}": ${e instanceof Error ? e.message : String(e)}` }
      }
    }

    if (lat === undefined || lon === undefined) {
      return { ok: false, error: 'Provide either a city name or both latitude and longitude' }
    }

    try {
      const forecastDays = Math.min(days ?? 3, 7)
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        timezone: 'auto',
        forecast_days: String(forecastDays)
      })
      const data = await fetch(`${WEATHER_BASE}?${params}`).then(r => r.json())
      if (!data.current) {
        return { ok: false, error: 'Weather API returned no data' }
      }

      const daily = (data.daily?.time ?? []).map((d: string, i: number) => ({
        date: d,
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        precipChance: data.daily.precipitation_probability_max?.[i],
        code: data.daily.weather_code[i]
      }))

      return {
        ok: true,
        location: data.timezone,
        current: {
          temperature: data.current.temperature_2m,
          feelsLike: data.current.apparent_temperature,
          humidity: data.current.relative_humidity_2m,
          windSpeed: data.current.wind_speed_10m,
          weatherCode: data.current.weather_code,
          isDay: data.current.is_day === 1
        },
        daily
      }
    } catch (e) {
      return { ok: false, error: `Weather request failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
})

export const getExchangeRate = tool({
  description:
    'Get the latest exchange rate from one currency to another. Use ISO codes, e.g. from "USD" to "CNY". Free API, no key needed.',
  inputSchema: z.object({
    from: z.string().describe('Source currency ISO code, e.g. "USD"'),
    to: z.string().describe('Target currency ISO code, e.g. "CNY"')
  }),
  execute: async ({ from, to }) => {
    try {
      const fromUpper = from.toUpperCase()
      const toUpper = to.toUpperCase()
      const data = await fetch(`https://open.er-api.com/v6/latest/${fromUpper}`).then(r => r.json())
      if (data.result !== 'success' || !data.rates?.[toUpper]) {
        return { ok: false, error: `No rate for ${fromUpper} -> ${toUpper}` }
      }
      return {
        ok: true,
        from: fromUpper,
        to: toUpper,
        rate: data.rates[toUpper],
        updated: data.time_last_update_utc
      }
    } catch (e) {
      return { ok: false, error: `Exchange rate request failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
})

export const ApiTool = {
  GetWeather: getWeather,
  GetExchangeRate: getExchangeRate
}

export type ApiToolKeys = keyof typeof ApiTool
