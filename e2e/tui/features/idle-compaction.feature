Feature: Idle conversation compaction

  Under CHAT_CACHE_TTL=1h, a large conversation left idle for most of its
  cache's lifetime is compacted before that cache expires. The suite seeds a
  conversation whose last chat turn ran almost that long ago and restarts the
  runtime, which schedules the compaction again from the stored data.

  Scenario: A runtime restart keeps an idle conversation's compaction scheduled
    Given a large conversation whose last chat turn ran almost 54 minutes ago
    When the runtime restarts
    And I launch the CLI
    Then the CLI shows that the conversation was compacted while idle
    And the older messages are compacted while the newest stay
