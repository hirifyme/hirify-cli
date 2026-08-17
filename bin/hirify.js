#!/usr/bin/env node
// Hirify CLI - доступ агента к вакансиям Hirify (вторая равноправная дверь - MCP).
//
// Тонкий клиент над живым REST-слоем `api.hirify.me/api/agent/*` (тот же, что под MCP).
// Нулевые зависимости: Node 18+ (встроенный fetch), запускается через `npx hirify`.
//
// Правило метрирования (то же, что на бэке): чтение вакансий бесплатно и без лимита,
// раскрытие контакта тратит 1 из дневного лимита, повтор по той же вакансии - бесплатно.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'

const API = process.env.HIRIFY_API || 'https://api.hirify.me'
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hirify')
// Один файл на любой способ входа: браузерная сессия и ключ из кабинета лежат в нём же.
// Разбирать «а откуда сейчас взялся токен» из двух файлов дороже, чем из одного поля `kind`.
const AUTH_FILE = join(CONFIG_DIR, 'auth.json')
// Файл ключа из версии 0.1: читаем ради тех, кто уже им пользуется, но больше не пишем.
const LEGACY_KEY_FILE = join(CONFIG_DIR, 'key')

const SCOPES = 'agent:read agent:reveal offline_access'
const CALLBACK_PATH = '/callback'
// Столько ждём подтверждения в браузере. Код авторизации на той стороне живёт те же 5 минут.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

const HELP = `hirify - доступ AI-агента к вакансиям Hirify

  hirify login                  войти через браузер
  hirify me                     тариф и остаток дневного лимита
  hirify feeds                  ваши сохранённые фиды
  hirify feed <id>              вакансии из фида            [--limit N]
  hirify search <запрос>        поиск вакансий по критериям [--limit N] [--grade G]
  hirify reveal <slug>          КУДА ОТКЛИКНУТЬСЯ: тратит 1 из дневного лимита
  hirify logout                 выйти на этом компьютере

  --json                        сырой JSON вместо текста (для парсинга)

Лимиты: чтение (me, feeds, feed, search) бесплатно и без ограничений.
        reveal тратит 1 из дневного лимита, остаток видно в hirify me.
        Повторное раскрытие той же вакансии бесплатно.
Правила для агента: npx skills add hirifyme/hirify
Без браузера (CI, сервер): hirify auth <ключ> или переменная HIRIFY_KEY.
        Ключ: hirify.me/account/api-access`

// ── утилиты ────────────────────────────────────────────────────────────────
const die = (msg, code = 1) => { console.error(`hirify: ${msg}`); process.exit(code) }

const flag = (args, name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const out = (data, text) => {
  if (process.argv.includes('--json')) console.log(JSON.stringify(data, null, 2))
  else text()
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const now = () => Math.floor(Date.now() / 1000)

// ── хранилище доступа ──────────────────────────────────────────────────────
function readSession() {
  if (existsSync(AUTH_FILE)) {
    try {
      const s = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
      if (s && typeof s.access_token === 'string' && s.access_token) return s
    } catch {
      // Битый файл - не повод падать: ведём себя как «входа нет».
    }
  }
  if (existsSync(LEGACY_KEY_FILE)) {
    const key = readFileSync(LEGACY_KEY_FILE, 'utf8').trim()
    if (key) return { kind: 'key', access_token: key }
  }
  return null
}

function writeSession(session) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(AUTH_FILE, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 })
}

function forgetSession() {
  let had = false
  for (const file of [AUTH_FILE, LEGACY_KEY_FILE]) {
    if (existsSync(file)) { rmSync(file); had = true }
  }
  return had
}

const NOT_LOGGED_IN =
  'вы ещё не вошли. Выполните `hirify login` - откроется браузер.\n' +
  '        Без браузера (CI, сервер): `hirify auth <ключ>` или переменная HIRIFY_KEY.\n' +
  '        Ключ: hirify.me/account/api-access'

/**
 * Токен для запроса. Приоритет у переменной окружения: она есть только там, где её
 * поставили осознанно (CI, сервер), и локальный вход не должен её перебивать.
 * Браузерная сессия обновляется заранее, за минуту до истечения, чтобы человек не
 * ловил 401 на ровном месте.
 */
async function accessToken() {
  if (process.env.HIRIFY_KEY) return process.env.HIRIFY_KEY

  const session = readSession()
  if (!session) die(NOT_LOGGED_IN)

  if (session.kind === 'oauth' && session.expires_at && session.expires_at - 60 <= now()) {
    return (await refreshSession(session)).access_token
  }
  return session.access_token
}

// ── HTTP к API ─────────────────────────────────────────────────────────────
async function request(path, method, token) {
  try {
    return await fetch(`${API}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  } catch (e) {
    die(`кажется, сеть недоступна: ${e.message}`)
  }
}

async function api(path, { method = 'GET' } = {}) {
  let res = await request(path, method, await accessToken())

  // 401 на живой сессии - обычное дело: токен могли отозвать при ротации refresh.
  // Один тихий обмен и повтор, и только потом отправляем человека входить заново.
  if (res.status === 401 && !process.env.HIRIFY_KEY) {
    const session = readSession()
    if (session?.kind === 'oauth' && session.refresh_token) {
      const fresh = await refreshSession(session)
      res = await request(path, method, fresh.access_token)
    }
  }

  if (res.status === 401) {
    die(process.env.HIRIFY_KEY || readSession()?.kind === 'key'
      ? 'ключ не принят (401). Кажется, он отозван или скопирован не целиком.'
      : 'кажется, вход больше не действует. Пожалуйста, выполните `hirify login` ещё раз.')
  }
  if (res.status === 403) die('нет доступа (403). Нужен активный платный тариф, либо у доступа нет нужного права.')
  if (res.status === 404) die('не найдено (404).')
  if (res.status === 429) die('дневной лимит исчерпан (429). Он обнуляется в 00:00.')
  const body = await res.json().catch(() => null)
  if (!res.ok) die(`API ответил ${res.status}: ${body ? JSON.stringify(body) : '(пустой ответ)'}`)
  // Отдаём тело ЦЕЛИКОМ: у списков рядом с `data` едет `meta` (total/last_page),
  // и в --json агент должен видеть её тоже. Разворачивают уже команды.
  return body
}

// ── OAuth: вход через браузер ──────────────────────────────────────────────
/**
 * Адреса сервера авторизации. Спрашиваем их у него самого (RFC 8414), а не зашиваем:
 * если ручки переедут, CLI поедет за ними. Если документа нет - идём по умолчанию.
 */
async function discover() {
  const fallback = {
    authorization_endpoint: `${API}/oauth/authorize`,
    token_endpoint: `${API}/oauth/token`,
    registration_endpoint: `${API}/oauth/register`,
  }
  try {
    const res = await fetch(`${API}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return fallback
    const meta = await res.json()
    return {
      authorization_endpoint: meta.authorization_endpoint || fallback.authorization_endpoint,
      token_endpoint: meta.token_endpoint || fallback.token_endpoint,
      registration_endpoint: meta.registration_endpoint || fallback.registration_endpoint,
    }
  } catch {
    return fallback
  }
}

/** Тело формы, а не JSON: так требует RFC 6749, и так эту ручку ждёт сервер. */
async function postForm(url, params) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    })
  } catch (e) {
    die(`кажется, сеть недоступна: ${e.message}`)
  }
  const body = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

/**
 * Слушаем ответ браузера на петле. Порт занимаем эфемерный (0): так он свободен
 * всегда, и два входа подряд не дерутся за один и тот же номер.
 */
async function startCallbackServer() {
  let settle
  const received = new Promise((resolve) => { settle = resolve })

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(browserPage(error))
    settle({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error,
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (e) => reject(e)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      // Дальше падать из-за одного кривого запроса от браузера незачем.
      server.on('error', () => {})
      resolve()
    })
  })

  return { port: server.address().port, received, close: () => server.close() }
}

/**
 * Страница, которую человек видит в браузере после подтверждения. «Вы вошли» тут не
 * пишем: обмен кода на токены случится уже после ответа браузеру, и обещать его итог
 * страница не может - итог человек увидит в терминале.
 */
function browserPage(error) {
  const title = error ? 'Вход не завершён' : 'Подтверждение получено'
  const text = error
    ? 'Кажется, подключение не завершилось. Пожалуйста, вернитесь в терминал и попробуйте ещё раз.'
    : 'Можно закрыть эту вкладку и вернуться в терминал.'
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hirify</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:#1a1a1a; background:#fafafa; }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p { margin:0; color:#555; }
</style>
<main><h1>${title}</h1><p>${text}</p></main></html>`
}

/**
 * Открыть браузер. Успех тут - «команда запустилась»: узнать, что человек её реально
 * увидел, мы не можем, поэтому ссылку в терминал печатаем в любом случае.
 */
function openBrowser(url) {
  const candidates = process.env.BROWSER
    ? [[process.env.BROWSER, [url]]]
    : process.platform === 'darwin' ? [['open', [url]]]
    : process.platform === 'win32' ? [['cmd', ['/c', 'start', '', url]]]
    : [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]], ['x-www-browser', [url]]]

  const tryOne = (i) => new Promise((resolve) => {
    if (i >= candidates.length) return resolve(false)
    const [cmd, args] = candidates[i]
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    } catch {
      return resolve(tryOne(i + 1))
    }
    child.once('error', () => resolve(tryOne(i + 1)))
    child.once('spawn', () => { child.unref(); resolve(true) })
  })

  return tryOne(0)
}

async function cmdLogin(args) {
  const noBrowser = args.includes('--no-browser')
  const endpoints = await discover()

  let listener
  try {
    listener = await startCallbackServer()
  } catch (e) {
    die('кажется, не удалось открыть локальный адрес для ответа браузера: ' + e.message +
      '\n        Пожалуйста, войдите ключом: `hirify auth <ключ>` (hirify.me/account/api-access).')
  }

  const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`

  // Клиент регистрируем на каждый вход: адрес возврата сверяется точь-в-точь,
  // а порт у нас каждый раз новый. Секрета у клиента нет, подмену держит PKCE.
  let clientId
  try {
    const res = await fetch(endpoints.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Hirify CLI', redirect_uris: [redirectUri] }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.client_id) {
      listener.close()
      die(`кажется, не удалось начать вход: сервер ответил ${res.status}. Пожалуйста, попробуйте ещё раз.`)
    }
    clientId = body.client_id
  } catch (e) {
    listener.close()
    die(`кажется, сеть недоступна: ${e.message}`)
  }

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const authUrl = `${endpoints.authorization_endpoint}?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  const opened = noBrowser ? false : await openBrowser(authUrl)
  console.log(opened
    ? 'Открываем браузер, подтвердите доступ на hirify.me.'
    : 'Пожалуйста, откройте эту ссылку в браузере и подтвердите доступ:')
  if (!opened) console.log(`\n${authUrl}\n`)
  else console.log(`Если браузер не открылся, откройте ссылку вручную:\n${authUrl}`)

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), LOGIN_TIMEOUT_MS))
  const answer = await Promise.race([listener.received, timeout])
  listener.close()

  if (answer.timedOut) {
    die('мы не дождались подтверждения в браузере. Пожалуйста, выполните `hirify login` ещё раз.')
  }
  if (answer.error === 'access_denied') {
    die('доступ не подтверждён, ничего не сохранено. Если это вышло случайно, выполните `hirify login` ещё раз.')
  }
  if (answer.error) {
    die('кажется, вход не завершился. Пожалуйста, выполните `hirify login` ещё раз.')
  }
  if (answer.state !== state) {
    die('кажется, ответ браузера пришёл не от того входа. Пожалуйста, выполните `hirify login` ещё раз.')
  }
  if (!answer.code) {
    die('кажется, браузер вернулся без кода подтверждения. Пожалуйста, выполните `hirify login` ещё раз.')
  }

  const { ok, body } = await postForm(endpoints.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: answer.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })

  if (!ok || !body?.access_token) {
    // Код подтверждения живёт пять минут и срабатывает один раз. Чаще всего сюда
    // приходят те, у кого он успел истечь, поэтому просим просто войти заново.
    die('кажется, вход не завершился: подтверждение устарело или уже было использовано.' +
      '\n        Пожалуйста, выполните `hirify login` ещё раз.')
  }

  writeSession({
    kind: 'oauth',
    issuer: API,
    client_id: clientId,
    token_endpoint: endpoints.token_endpoint,
    access_token: body.access_token,
    refresh_token: body.refresh_token || null,
    scope: body.scope || SCOPES,
    expires_at: body.expires_in ? now() + Number(body.expires_in) : null,
  })

  console.log(`\nГотово, вы вошли. Доступ сохранён: ${AUTH_FILE}`)
  // Показываем остаток сразу: это первое, что человек всё равно спросит.
  try {
    await cmdMe()
  } catch {
    // Вход состоялся, а справка по тарифу не обязательна.
  }
  console.log('\nПравила работы для агента: npx skills add hirifyme/hirify')
}

/**
 * Обмен refresh на новую пару. Refresh ротируется на каждом обмене, поэтому пишем
 * файл сразу: потерять новый refresh дороже, чем лишний раз записать файл.
 */
async function refreshSession(session) {
  if (!session.refresh_token) {
    die('кажется, вход устарел. Пожалуйста, выполните `hirify login` ещё раз.')
  }

  const { ok, body } = await postForm(session.token_endpoint || `${API}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: session.client_id,
    refresh_token: session.refresh_token,
  })

  if (!ok || !body?.access_token) {
    die('кажется, вход устарел. Пожалуйста, выполните `hirify login` ещё раз.')
  }

  const fresh = {
    ...session,
    access_token: body.access_token,
    refresh_token: body.refresh_token || session.refresh_token,
    scope: body.scope || session.scope,
    expires_at: body.expires_in ? now() + Number(body.expires_in) : null,
  }
  writeSession(fresh)
  return fresh
}

function cmdLogout() {
  console.log(forgetSession()
    ? 'Готово, вы вышли на этом компьютере.'
    : 'Здесь и так никто не вошёл.')
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

// Поля - строго из AgentVacancyResource: контактов в карточке нет by design,
// компания у премиум-компаний приезжает маскированной (company_masked).
function printVacancies(list, meta) {
  if (!list.length) return console.log('ничего не найдено')
  for (const v of list) {
    // `company_masked` - это ФЛАГ «имя скрыто до раскрытия», а не строка с именем.
    // Раньше он печатался как есть, и в карточке появлялось «- true».
    const company = v.company || (v.company_masked ? 'компания скрыта' : '-')
    const bits = [v.remote_type, v.work_format, v.employee_type, v.english_level].filter(Boolean)
    if (v.salary && (v.salary.min || v.salary.max)) {
      const { min, max, currency } = v.salary
      bits.push([min, max].filter(Boolean).join('-') + (currency ? ` ${currency}` : ''))
    }
    if (v.verified) bits.push('verified')
    console.log(`${v.slug}\n  ${v.title || '-'} · ${company}${bits.length ? `\n  [${bits.join(' · ')}]` : ''}`)
  }
  const total = meta?.total
  console.log(`\nПоказано ${list.length}${total ? ` из ${total}` : ''}. Куда откликнуться: hirify reveal <slug> (тратит 1 из лимита).`)
}

async function cmdFeed(args) {
  const id = args[0]
  if (!id) die('нужен id фида: hirify feed <id>  (список: hirify feeds)')
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

/** Строка контакта: адрес как есть, тип - только если он что-то добавляет. */
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

/** Запасной вход для CI и серверов, где браузера нет. Обычный путь - `hirify login`. */
function cmdAuth(args) {
  const key = args[0]
  if (!key) {
    die('вход через браузер: `hirify login`.\n' +
      '        Ключом (CI, сервер): `hirify auth <ключ>`, ключ на hirify.me/account/api-access')
  }
  writeSession({ kind: 'key', access_token: key })
  if (existsSync(LEGACY_KEY_FILE)) rmSync(LEGACY_KEY_FILE)
  console.log(`Ключ сохранён: ${AUTH_FILE}`)
}

/** Скилл теперь раздаётся через skills.sh: одна команда ставит его во все харнессы сразу. */
function cmdSkill() {
  console.log('Правила работы для агента ставятся одной командой:\n\n  npx skills add hirifyme/hirify\n')
  console.log('Она кладёт их туда, где их читает ваш агент: Claude Code, Codex, Cursor, OpenCode и другие.')
}

// ── роутер ─────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2)
const routes = {
  login: cmdLogin, logout: cmdLogout, auth: cmdAuth,
  me: cmdMe, feeds: cmdFeeds, feed: cmdFeed, search: cmdSearch, reveal: cmdReveal,
  skill: cmdSkill,
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); process.exit(0) }
if (!routes[cmd]) die(`неизвестная команда: ${cmd}\n\n${HELP}`)
await routes[cmd](args)
