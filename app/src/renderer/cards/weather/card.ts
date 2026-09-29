// 天气卡（工单10 内置桌面组件 2/5）：唯一纯前端直连的卡片（Open-Meteo 先例平移），
// 坐标经快照的 weather 段下发。取数状态（进行中标志、刷新定时器）随插件生命周期走：
// 卸载必清定时器，否则拔掉插件还留着每 10 分钟一次的野请求。
import type { PluginApi, PluginHost } from '../../plugins.js'
import type { WeatherLocation } from '../../../shared/contract'

const WEATHER_REFRESH_MS = 10 * 60 * 1000
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Cloudy',
  45: 'Foggy', 48: 'Rime Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  56: 'Light Freezing Drizzle', 57: 'Freezing Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
  66: 'Light Freezing Rain', 67: 'Freezing Rain',
  71: 'Slight Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
  80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
  85: 'Light Snow Showers', 86: 'Snow Showers',
  95: 'Thunderstorm', 96: 'Light Thunderstorm With Hail', 99: 'Thunderstorm With Hail',
}

let temp: HTMLElement
let desc: HTMLElement
let detail: HTMLElement
let location: WeatherLocation | null = null
let fetching = false
let timer: ReturnType<typeof setInterval> | null = null

async function fetchWeather(host: PluginHost): Promise<void> {
  if (!location || fetching || !desc) return
  fetching = true
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${location.latitude}&longitude=${location.longitude}`
    + '&current=temperature_2m,precipitation,wind_speed_10m,weather_code,relative_humidity_2m'
    + '&timezone=auto'
  const abort = new AbortController()
  const abortTimer = setTimeout(() => { abort.abort() }, 10000)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: abort.signal })
    if (!r.ok) throw new Error(String(r.status))
    const data = await r.json()
    const c = data.current
    if (!c) throw new Error('no current block')
    temp.innerHTML = `${Math.round(c.temperature_2m)}&deg;C`
    desc.textContent = WEATHER_CODES[c.weather_code] ?? `CODE ${c.weather_code}`
    detail.textContent =
      `WIND ${Number(c.wind_speed_10m).toFixed(1)} M/S · RH ${Math.round(c.relative_humidity_2m)}%`
      + ` · PREC ${Number(c.precipitation).toFixed(1)} MM`
    host.notify('weather-rendered', { code: c.weather_code, temp: Math.round(c.temperature_2m) })
  } catch (err) {
    desc.textContent = 'FETCH FAILED'
    host.notify('weather-error', { message: String(err) })
  } finally {
    clearTimeout(abortTimer)
    fetching = false
  }
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'weather-card'
    card.innerHTML =
      '<h2>WEATHER</h2>'
      + '<div id="weather-temp">--&deg;</div>'
      + '<div id="weather-desc">FETCHING</div>'
      + '<div id="weather-detail">WIND -- M/S &middot; RH --% &middot; PREC -- MM</div>'
    host.el.appendChild(card)
    temp = card.querySelector('#weather-temp') as HTMLElement
    desc = card.querySelector('#weather-desc') as HTMLElement
    detail = card.querySelector('#weather-detail') as HTMLElement
    location = null
    fetching = false
    if (timer) clearInterval(timer)
    timer = setInterval(() => { void fetchWeather(host) }, WEATHER_REFRESH_MS)
    this.update?.(host)
  },

  update(host: PluginHost): void {
    const loc = host.view.weather
    if (!loc) return
    const moved = !location || location.latitude !== loc.latitude || location.longitude !== loc.longitude
    location = { latitude: loc.latitude, longitude: loc.longitude }
    if (moved) void fetchWeather(host)
  },

  unmount(): void {
    if (timer) clearInterval(timer)
    timer = null
    location = null
  },
} satisfies PluginApi
