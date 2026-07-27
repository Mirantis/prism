// See CLAUDE.md → "Commit messages". Enforced in CI by lint.yml.
//
// NOTE: this file must be `.mjs`. The CI action (wagoid/commitlint-github-action)
// only auto-loads `commitlint.config.mjs` and explicitly rejects a `.js`
// config; with a `.js` file it silently falls back to bare config-conventional
// and none of the customisation below runs in CI.

// Exempt git *trailer* lines from the body/footer line-length limit while
// still capping ordinary prose at 100 characters.
//
// Why we can't just wrap: every commit in this repo carries a mandatory fleet
// convention trailer whose value is a long agent-profile URL, e.g.
//   Agent: Prismith <https://agents.lenshq.io/orgs/…/sandboxes/…>
// The URL is emitted verbatim by the agent runtime (~190 chars) and cannot be
// wrapped or shortened without breaking the trailer, so a hard 100-char limit
// is impossible to satisfy for those lines. The same is true of a long
// `Signed-off-by:` / `Co-authored-by:` identity. config-conventional's built-in
// `body-max-line-length` / `footer-max-line-length` (both `[2, 'always', 100]`)
// have no such exemption, so they fire on every commit here.
//
// We do NOT disable length checking outright (`[0]`): prose body lines must
// still wrap at 100 so long paragraphs stay reviewable. Instead we replace the
// two built-in rules with one local plugin rule that operates on the raw commit
// message (minus the subject line, which `header-max-line-length` owns),
// skips any git-trailer line (`Key: value`), and caps everything else at 100.
//
// Operating on `parsed.raw` — rather than `parsed.body` / `parsed.footer` —
// is deliberate: the commitlint parser splits trailers out into `footer` and
// leaves prose in `body`, but exactly where a given line lands is a parser
// implementation detail that has shifted across versions. Reasoning over the
// raw text makes the behaviour deterministic and identical no matter whether
// the CI action's bundled commitlint (v19, no native URL exemption) or the
// repo devDependency (v21) evaluates it.

// A git trailer line: a token of letters/hyphens, then `:` and whitespace.
// Covers Agent:, Signed-off-by:, Co-authored-by:, Refs:, Closes:, etc.
const TRAILER_REGEX = /^[A-Za-z][A-Za-z-]*:\s/;

const MAX_BODY_LINE_LENGTH = 100;

const bodyLineLengthIgnoringTrailers = ({ raw }, _when, max) => {
  // An absent/empty message trivially satisfies the rule (mirrors the built-in
  // rules' `if (!input) return [true]` guard).
  if (!raw) return [true, ''];
  // Drop the subject line; its length is enforced by `header-max-line-length`.
  const lines = raw.split(/\r?\n/).slice(1);
  const offenders = lines.filter(
    (line) => !TRAILER_REGEX.test(line) && line.length > max,
  );
  const message =
    `body's lines must not be longer than ${max} characters ` +
    `(git trailer lines are exempt)` +
    (offenders.length ? `:\n${offenders.map((l) => `  "${l}"`).join('\n')}` : '');
  return [offenders.length === 0, message];
};

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'body-max-line-length-ignoring-trailers': bodyLineLengthIgnoringTrailers,
      },
    },
  ],
  rules: {
    // Replace the built-in length rules with the trailer-aware equivalent.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'body-max-line-length-ignoring-trailers': [2, 'always', MAX_BODY_LINE_LENGTH],
    // .husky/prepare-commit-msg appends Signed-off-by locally; this enforces
    // it server-side too so commits made with --no-verify still fail CI.
    'signed-off-by': [2, 'always', 'Signed-off-by:'],
  },
  // GitHub's Copilot Autofix bot commits through the web UI, which has no DCO
  // sign-off path — those commits can't carry a Signed-off-by trailer and
  // would otherwise fail the rule above. Skip linting them entirely (matched
  // by the bot's stable account identity) rather than blocking the PR.
  ignores: [(message) => message.includes('175728472+Copilot@users.noreply.github.com')],
};
