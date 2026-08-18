// See AGENTS.md → "Commit messages". Enforced in CI by lint.yml.
//
// NOTE: this file must be `.mjs`. lint.yml runs the repo's own pinned
// commitlint (`@commitlint/cli@^21`) and points `--config` at this file, so
// the customisation below actually runs in CI.
//
// max-line-length URL exemption: @commitlint/config-conventional v21 exempts
// any body/footer line that contains a URL from `body-max-line-length` /
// `footer-max-line-length` natively. That is what lets the mandatory agent
// attribution trailers — which carry long, unwrappable agent profile URLs —
// pass while genuinely long prose lines (no URL, >100 chars) still fail. A
// future downgrade below v21 would drop this native exemption and reintroduce
// the failure, so keep the pin at >=21.

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
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
