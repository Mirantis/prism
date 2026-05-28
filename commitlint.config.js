// See CLAUDE.md → "Commit messages". Enforced in CI by lint.yml.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // .husky/prepare-commit-msg appends Signed-off-by locally; this enforces
    // it server-side too so commits made with --no-verify still fail CI.
    'signed-off-by': [2, 'always', 'Signed-off-by:'],
  },
};
