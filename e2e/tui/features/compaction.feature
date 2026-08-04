Feature: Automatic conversation compaction

  The runtime folds older history into a summary when the measured context
  occupancy crosses the threshold. The suite forces the trigger by declaring a
  tiny context window: the system prompt alone fills it, so the first eligible
  turn compacts.

  Scenario: A full context window triggers compaction after a turn
    Given a fresh CLI session against a tiny context window
    When I send a message and the turn completes
    And I send a second message and the turn completes
    Then the thread gains a compaction summary in the database
    And older messages are marked compacted while the tail survives
    And the CLI shows the compaction note
