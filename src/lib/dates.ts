// Datas de negócio são strings ISO 'YYYY-MM-DD' no fuso de São Paulo.
// Instantes (prazo, envio) chegam como timestamptz ISO.
export const TZ = 'America/Sao_Paulo'

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
})

export const WEEKDAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
export const WEEKDAYS_LONG = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro']

/** Data local (São Paulo) de um instante. */
export function localDate(at: Date | string = new Date()): string {
  return dayFmt.format(typeof at === 'string' ? new Date(at) : at)
}
export const todayISO = () => localDate()

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}
function utc(iso: string) {
  const { y, m, d } = parts(iso)
  return new Date(Date.UTC(y, m - 1, d))
}
const toISO = (dt: Date) => dt.toISOString().slice(0, 10)

export function addDays(iso: string, n: number): string {
  const dt = utc(iso)
  dt.setUTCDate(dt.getUTCDate() + n)
  return toISO(dt)
}
/** ISO: 1 = segunda … 7 = domingo */
export function isoWeekday(iso: string): number {
  const w = utc(iso).getUTCDay()
  return w === 0 ? 7 : w
}
export const startOfWeek = (iso: string) => addDays(iso, 1 - isoWeekday(iso))
export const startOfMonth = (iso: string) => iso.slice(0, 8) + '01'
export function endOfMonth(iso: string): string {
  const { y, m } = parts(iso)
  return toISO(new Date(Date.UTC(y, m, 0)))
}
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000)
}
export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export const fmtTime = (ts: string) => timeFmt.format(new Date(ts))
export const fmtDateTime = (ts: string) => dateTimeFmt.format(new Date(ts)).replace('.', '').replace(',', ' ·')
export function fmtDay(iso: string): string {
  const { m, d } = parts(iso)
  return `${d} ${MONTHS[m - 1]}`
}
export function fmtDayLong(iso: string): string {
  const { m, d } = parts(iso)
  const wd = WEEKDAYS_LONG[isoWeekday(iso) - 1]
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)}, ${d} de ${MONTHS_LONG[m - 1]}`
}
export const fmtWeekday = (iso: string) => WEEKDAYS_SHORT[isoWeekday(iso) - 1]
export function fmtMonth(iso: string): string {
  const { y, m } = parts(iso)
  return `${MONTHS_LONG[m - 1]} de ${y}`
}

/** "em 1 h 20 min", "há 35 min" — distância até um instante. */
export function relative(ts: string, now = Date.now()): string {
  const diff = new Date(ts).getTime() - now
  const min = Math.round(Math.abs(diff) / 60_000)
  if (min < 1) return 'agora'
  let txt: string
  if (min < 60) txt = `${min} min`
  else if (min < 60 * 24) {
    const h = Math.floor(min / 60), mm = min % 60
    txt = mm ? `${h} h ${mm} min` : `${h} h`
  } else {
    const d = Math.round(min / 1440)
    txt = d === 1 ? '1 dia' : `${d} dias`
  }
  return diff >= 0 ? `em ${txt}` : `há ${txt}`
}

export type PeriodPreset = 'hoje' | 'semana' | 'mes' | '30d' | 'custom'
export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  hoje: 'Hoje', semana: 'Semana', mes: 'Mês', '30d': '30 dias', custom: 'Intervalo',
}
export function presetRange(p: PeriodPreset, today = todayISO()): { from: string; to: string } {
  switch (p) {
    case 'hoje': return { from: today, to: today }
    case 'semana': return { from: startOfWeek(today), to: addDays(startOfWeek(today), 6) }
    case 'mes': return { from: startOfMonth(today), to: endOfMonth(today) }
    default: return { from: addDays(today, -29), to: today }
  }
}

/** Data local (dia) de um instante, no formato "13 nov". Sem horário. */
export const fmtDayOf = (ts: string) => fmtDay(localDate(ts))

/**
 * Prazo por data, sem horário: "vence hoje", "vence amanhã", "vence em 3 dias",
 * "venceu ontem", "venceu há 2 dias". `dueDay` é a data local de vencimento (YYYY-MM-DD).
 */
export function dueText(dueDay: string, today = todayISO()): { text: string; late: boolean } {
  const d = daysBetween(today, dueDay)
  if (d === 0) return { text: 'vence hoje', late: false }
  if (d === 1) return { text: 'vence amanhã', late: false }
  if (d > 1) return { text: `vence em ${d} dias`, late: false }
  if (d === -1) return { text: 'venceu ontem', late: true }
  return { text: `venceu há ${-d} dias`, late: true }
}
