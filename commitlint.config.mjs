// See CLAUDE.md → "Commit messages". Enforced in CI by lint.yml.
//
// NOTE: this file must be `.mjs`. The CI action (wagoid/commitlint-github-action)
// only auto-loads `commitlint.config.mjs` and explicitly rejects a `.js`
// config; with a `.js` file it silently falls back to bare config-conventional
// and none of the customisation below runs in CI.

// Exempt lines that contain a URL from the max-line-length rules.
//
// Agent attribution trailers (a mandatory fleet convention) carry long agent
// profile URLs that cannot be wrapped without breaking the trailer, so a hard
// 100-char limit is impossible to satisfy for those lines. This mirrors the
// exemption that @commitlint/config-conventional v21 applies natively; we
// implement it as a plugin rule so the behaviour is identical regardless of
// which commitlint version runs it (the CI action bundles v19, which lacks the
// native exemption, while the repo devDependency is v21).
//
// The exemption is generic — any line containing an http(s) URL is skipped —
// so genuinely long prose lines (with no URL) are still caught.
//
// This copies config-conventional's URL_REGEX and per-line logic verbatim;
// re-check against upstream if commitlint is bumped across a major version.
const URL_REGEX = /\bhttps?:\/\/\S+/;
const maxLineLengthAllowingUrls = (value, max) =>
  // An absent body/footer trivially satisfies the rule (mirrors the built-in
  // rules' `if (!input) return [true]` guard).
  !value ||
  (typeof value === 'string' &&
    value.split(/\r?\n/).every((line) => URL_REGEX.test(line) || line.length <= max));

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'body-max-line-length-allow-urls': ({ body }, _when, max) => [
          maxLineLengthAllowingUrls(body, max),
          `body's lines must not be longer than ${max} characters (URLs exempted)`,
        ],
        'footer-max-line-length-allow-urls': ({ footer }, _when, max) => [
          maxLineLengthAllowingUrls(footer, max),
          `footer's lines must not be longer than ${max} characters (URLs exempted)`,
        ],
      },
    },
  ],
  rules: {
    // Replace the built-in length rules with URL-exempting equivalents.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'body-max-line-length-allow-urls': [2, 'always', 100],
    'footer-max-line-length-allow-urls': [2, 'always', 100],
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
