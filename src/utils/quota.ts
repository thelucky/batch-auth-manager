import { CODEX_PLAN_LABELS } from '../config/constants'

/** 将接口套餐代码转换为显示名称，未知套餐保留原值。 */
export function formatQuotaPlanType(planType: string): string {
  return CODEX_PLAN_LABELS[planType.trim().toLowerCase()] || planType
}

/**
 * 格式化配额重置时间
 * @param value ISO 字符串或 Unix 时间戳（秒）
 * @param showRemainingHours 是否追加剩余天数和小时数，按小时向上取整
 */
export function formatResetTime(value?: string | number, showRemainingHours = false): string {
  if (!value) return '-'

  let date: Date
  if (typeof value === 'string') {
    date = new Date(value)
  } else {
    date = new Date(value * 1000)
  }

  if (isNaN(date.getTime())) return '-'

  const formatted = date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  if (!showRemainingHours) return formatted

  const HOUR_MS = 60 * 60 * 1000
  const HOURS_PER_DAY = 24
  const hours = Math.max(0, Math.ceil((date.getTime() - Date.now()) / HOUR_MS))
  const days = Math.floor(hours / HOURS_PER_DAY)
  const remainingHours = hours % HOURS_PER_DAY
  const remaining = days > 0
    ? `${days}d${remainingHours > 0 ? `${remainingHours}h` : ''}`
    : `${remainingHours}h`
  return `${formatted} (${remaining})`
}
