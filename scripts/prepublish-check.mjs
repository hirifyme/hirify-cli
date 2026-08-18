// Publish-order guard. Runs by itself from `prepublishOnly`, before `npm publish`.
//
// Why: README.md ships inside the npm tarball, and its first section tells the reader to
// run `npx skills add hirifyme/hirify-cli`. Publishing the package before the repository
// is public hands that line to real people and sends them to a repository they cannot
// open. So the rule is: repository first, npm second.
//
// This used to be an agreement written in an internal file. An agreement does not travel
// with the package and is not attached to the publish command, so nothing enforced it.
// This does.
//
// Escape hatch, when GitHub is unreachable and the publish has to happen anyway:
//   HIRIFY_SKIP_REPO_CHECK=1 npm publish

const REPO = 'hirifyme/hirify-cli'
const fail = (msg) => { console.error(`\nhirify: publish stopped.\n${msg}\n`); process.exit(1) }

if (process.env.HIRIFY_SKIP_REPO_CHECK) {
  console.error('hirify: repository visibility check skipped through HIRIFY_SKIP_REPO_CHECK.')
  process.exit(0)
}

// No token on purpose: what matters is exactly what an outsider sees. A private
// repository answers an anonymous request with 404 rather than 403.
let res
try {
  res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hirify-prepublish-check' },
  })
} catch (e) {
  fail(`Could not ask GitHub whether ${REPO} is public: ${e.message}\n` +
    'Check the network, or repeat with HIRIFY_SKIP_REPO_CHECK=1 if you are sure of the order.')
}

if (res.status === 404) {
  fail(`The repository ${REPO} is not public yet.\n` +
    `The README inside this package tells people to run \`npx skills add ${REPO}\`, and that\n` +
    'command would send them to a closed repository. Make the repository public first.')
}

if (!res.ok) {
  fail(`GitHub answered ${res.status} when asked about ${REPO}.\n` +
    'Try again later, or repeat with HIRIFY_SKIP_REPO_CHECK=1 if you are sure of the order.')
}

const repo = await res.json().catch(() => null)

if (repo?.private !== false) {
  fail(`GitHub did not confirm that ${REPO} is public. Make the repository public first.`)
}

console.error(`hirify: ${REPO} is public, the publish order holds.`)
