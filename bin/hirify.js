#!/usr/bin/env node
// Hirify CLI — доступ агента к вакансиям Hirify (вторая равноправная дверь — MCP).
//
// Тонкий клиент над живым REST-слоем `api.hirify.me/api/agent/*` (тот же, что под MCP).
// Нулевые зависимости: Node 18+ (встроенный fetch), запускается через `npx hirify`.
//
// Правило метрирования (то же, что на бэке): чтение вакансий бесплатно и без лимита,
// раскрытие контакта тратит 1 из дневного лимита, повтор по той же вакансии — бесплатно.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = process.env.HIRIFY_API || 'https://api.hirify.me'
const KEY_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hirify', 'key')
const HERE = dirname(fileURLToPath(import.meta.url))

const HELP = `hirify - доступ AI-агента к вакансиям Hirify

  hirify auth <ключ>            сохранить ключ (или задайте HIRIFY_KEY в окружении)
  hirify me                     тариф и остаток дневного лимита
  hirify feeds                  ваши сохранённые фиды
  hirify feed <id>              вакансии из фида            [--limit N]
  hirify search <запрос>        поиск вакансий по критериям [--limit N] [--grade G]
  hirify reveal <slug>          КУДА ОТКЛИКНУТЬСЯ: тратит 1 из дневного лимита
  hirify skill install          поставить скилл для Claude Code (.claude/skills/hirify/)

  --json                        сырой JSON вместо текста (для парсинга)

Лимиты: чтение (me, feeds, feed, search) бесплатно и без ограничений.
        reveal тратит 1 из дневного лимита, остаток видно в hirify me.
        Повторное раскрытие той же вакансии бесплатно.
Ключ:   hirify.me/account/api-access`

// ── утилиты ────────────────────────────────────────────────────────────────
const die = (msg, code = 1) => { console.error(`hirify: ${msg}`); process.exit(code) }

function getKey() {
  if (process.env.HIRIFY_KEY) return process.env.HIRIFY_KEY
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf8').trim()
  die('ключа нет. Выполните `hirify auth <ключ>` или задайте HIRIFY_KEY. Ключ: hirify.me/account/api-access')
}

async function api(path, { method = 'GET' } = {}) {
  let res
  try {
    res = await fetch(`${API}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${getKey()}`, Accept: 'application/json' },
    })
  } catch (e) {
    die(`сеть недоступна: ${e.message}`)
  }
  if (res.status === 401) die('ключ не принят (401). Кажется, он отозван или скопирован не целиком.')
  if (res.status === 403) die('нет доступа (403). Нужен активный платный тариф, либо у ключа нет нужного права.')
  if (res.status === 404) die('не найдено (404).')
  if (res.status === 429) die('дневной лимит исчерпан (429). Он обнуляется в 00:00.')
  const body = await res.json().catch(() => null)
  if (!res.ok) die(`API ответил ${res.status}: ${body ? JSON.stringify(body) : '(пустой ответ)'}`)
  // Отдаём тело ЦЕЛИКОМ: у списков рядом с `data` едет `meta` (total/last_page),
  // и в --json агент должен видеть её тоже. Разворачивают уже команды.
  return body
}

const flag = (args, name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const out = (data, text) => {
  if (process.argv.includes('--json')) console.log(JSON.stringify(data, null, 2))
  else text()
}

// ── команды ────────────────────────────────────────────────────────────────
async function cmdMe() {
  const body = await api('/agent/me')
  const d = body?.data ?? {}
  const q = d?.quota?.reveal
  const u = d?.usage?.reveal
  out(body, () => {
    console.log(`тариф:  ${d?.plan ?? '-'}`)
    if (q) console.log(`лимит:  ${q.used} / ${q.limit} раскрытий сегодня (осталось ${q.remaining})`)
    if (u) console.log(`расход: ${u.today} сегодня · ${u.last_7d} за 7д · ${u.last_30d} за 30д`)
  })
}

async function cmdFeeds() {
  const body = await api('/agent/feeds')
  const list = body?.data ?? []
  out(body, () => {
    if (!list.length) return console.log('фидов пока нет. Сохраните фильтр на hirify.me, и он станет фидом')
    for (const f of list) {
      const off = f.is_active === false ? '  (выключен)' : ''
      console.log(`${String(f.id).padEnd(6)} ${f.name || '(без названия)'}${off}`)
    }
    console.log(`\nВакансии из фида: hirify feed <id>`)
  })
}

// Поля — строго из AgentVacancyResource: контактов в карточке нет by design,
// компания у премиум-компаний приезжает маскированной (company_masked).
function printVacancies(list, meta) {
  if (!list.length) return console.log('ничего не найдено')
  for (const v of list) {
    // `company_masked` — это ФЛАГ «имя скрыто до раскрытия», а не строка с именем.
    // Раньше он печатался как есть, и в карточке появлялось «— true».
    const company = v.company || (v.company_masked ? 'компания скрыта' : '-')
    const bits = [v.remote_type, v.work_format, v.employee_type, v.english_level].filter(Boolean)
    if (v.salary && (v.salary.min || v.salary.max)) {
      const { min, max, currency } = v.salary
      bits.push([min, max].filter(Boolean).join('–') + (currency ? ` ${currency}` : ''))
    }
    if (v.verified) bits.push('verified')
    console.log(`${v.slug}\n  ${v.title || '-'} · ${company}${bits.length ? `\n  [${bits.join(' · ')}]` : ''}`)
  }
  const total = meta?.total
  console.log(`\nПоказано ${list.length}${total ? ` из ${total}` : ''}. Куда откликнуться: hirify reveal <slug> (тратит 1 из лимита).`)
}

async function cmdFeed(args) {
  const id = args[0]
  if (!id) die('нужен id фида: hirify feed <id>  (список — hirify feeds)')
  const limit = flag(args, '--limit')
  const body = await api(`/agent/feeds/${encodeURIComponent(id)}/vacancies${limit ? `?per_page=${limit}` : ''}`)
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

async function cmdSearch(args) {
  const query = args.filter((a) => !a.startsWith('--') && a !== flag(args, '--limit') && a !== flag(args, '--grade')).join(' ')
  const p = new URLSearchParams()
  if (query) p.set('search', query)
  const limit = flag(args, '--limit'); if (limit) p.set('per_page', limit)
  const grade = flag(args, '--grade'); if (grade) p.set('grade', grade)
  const body = await api(`/agent/vacancies?${p}`)
  out(body, () => printVacancies(body?.data ?? [], body?.meta))
}

/** Строка контакта: адрес как есть, тип — только если он что-то добавляет. */
function contactLine(c) {
  if (typeof c === 'string') return c
  const value = c?.value ?? c?.url ?? c?.email ?? null
  if (!value) return JSON.stringify(c)
  return c?.type && c.type !== 'url' ? `${value}  (${c.type})` : value
}

async function cmdReveal(args) {
  const slug = args[0]
  if (!slug) die('нужен slug: hirify reveal <slug>')
  const body = await api(`/agent/vacancies/${encodeURIComponent(slug)}/reveal`, { method: 'POST' })
  const d = body?.data ?? {}
  out(body, () => {
    console.log(`компания: ${d.company ?? '-'}`)
    if (d.linkedin) console.log(`linkedin: ${d.linkedin}`)
    // Контакт приезжает объектом {type, value, short_code}. Человеку и агенту нужен
    // сам адрес, а не его JSON: сырой объект в выводе никто не разбирает руками.
    for (const c of d.contacts ?? []) console.log(`контакт:  ${contactLine(c)}`)
    console.log(d.charged === false
      ? '\n(лимит не потрачен: эта вакансия уже раскрывалась)'
      : '\n(потрачено 1 раскрытие)')
    const q = d.quota
    if (q) console.log(`осталось ${q.remaining} из ${q.limit} на сегодня`)
  })
}

function cmdAuth(args) {
  const key = args[0]
  if (!key) die('нужен ключ: hirify auth <ключ>')
  mkdirSync(dirname(KEY_FILE), { recursive: true })
  writeFileSync(KEY_FILE, key, { mode: 0o600 })
  console.log(`ключ сохранён: ${KEY_FILE}`)
}

function cmdSkill(args) {
  if (args[0] !== 'install') die('поддерживается: hirify skill install')
  const dest = join(process.cwd(), '.claude', 'skills', 'hirify')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'SKILL.md'), readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8'))
  console.log(`скилл поставлен: ${join(dest, 'SKILL.md')}\nперезапусти агента — он подхватит его сам`)
}

// ── роутер ─────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2)
const routes = { me: cmdMe, feeds: cmdFeeds, feed: cmdFeed, search: cmdSearch, reveal: cmdReveal, auth: cmdAuth, skill: cmdSkill }

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); process.exit(0) }
if (!routes[cmd]) die(`неизвестная команда: ${cmd}\n\n${HELP}`)
await routes[cmd](args)
