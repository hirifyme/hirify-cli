// Страж порядка публикации. Запускается сам, из `prepublishOnly`, перед `npm publish`.
//
// Зачем: README уезжает в npm-пакет (`files`), а он с первой же строки зовёт
// `npx skills add hirifyme/hirify`. Если пакет опубликовать раньше, чем откроют
// репозиторий, эта строка поедет живым людям и приведёт их в приватный репозиторий,
// то есть в ошибку. Обратный порядок безопаснее, но тоже неполон, поэтому правило
// простое: сначала публичный репозиторий, потом npm.
//
// Раньше это правило жило договорённостью в CLAUDE.md. Договорённость наружу не едет
// и к самой команде публикации не привязана, поэтому её нечем соблюсти сессии без
// свежего контекста. Здесь она привязана.
//
// Аварийный выход, если GitHub недоступен, а публиковать надо:
//   HIRIFY_SKIP_REPO_CHECK=1 npm publish

const REPO = 'hirifyme/hirify'
const fail = (msg) => { console.error(`\nhirify: публикация остановлена.\n${msg}\n`); process.exit(1) }

if (process.env.HIRIFY_SKIP_REPO_CHECK) {
  console.error('hirify: проверка публичности репозитория пропущена по HIRIFY_SKIP_REPO_CHECK.')
  process.exit(0)
}

// Без токена: нам важно ровно то, что видит посторонний. Приватный репозиторий
// отвечает анониму 404, а не 403, поэтому проверяем именно анонимный запрос.
let res
try {
  res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hirify-prepublish-check' },
  })
} catch (e) {
  fail(`Не удалось спросить GitHub, открыт ли ${REPO}: ${e.message}\n` +
    'Проверьте сеть или, если уверены в порядке, повторите с HIRIFY_SKIP_REPO_CHECK=1.')
}

if (res.status === 404) {
  fail(`Репозиторий ${REPO} ещё не публичный.\n` +
    'README внутри пакета зовёт `npx skills add ' + REPO + '`, и эта команда приведёт\n' +
    'читателя в закрытый репозиторий. Сначала откройте репозиторий, потом публикуйте пакет.')
}

if (!res.ok) {
  fail(`GitHub ответил ${res.status} на вопрос о ${REPO}.\n` +
    'Повторите позже или, если уверены в порядке, повторите с HIRIFY_SKIP_REPO_CHECK=1.')
}

const repo = await res.json().catch(() => null)

if (repo?.private !== false) {
  fail(`GitHub не подтвердил, что ${REPO} открыт. Сначала откройте репозиторий, потом публикуйте.`)
}

console.error(`hirify: ${REPO} открыт, порядок публикации соблюдён.`)
