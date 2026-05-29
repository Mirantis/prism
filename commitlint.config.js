// See CLAUDE.md → "Commit messages". Enforced in CI by lint.yml.
module.exports = {
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
