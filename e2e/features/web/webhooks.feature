Feature: Inbound webhooks
  As a user I want external systems (Alertmanager, PagerDuty, GitHub, ...) to
  trigger my agent by POSTing to a named webhook endpoint, managed from the
  Webhooks page. The receiver starts disabled per scenario (per-scenario DB
  reset), so each scenario enables it first. Deliver-only subscriptions render
  the payload template straight into the conversation with no LLM call; the
  agent-mode scenario exercises a real Bedrock run end-to-end.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Enable the webhook receiver from the banner
    When I navigate to the webhooks page
    Then the webhook receiver banner is visible
    When I enable the webhook receiver
    Then the stored webhook receiver state is enabled

  Scenario: A deliver-only subscription renders the payload into the conversation without the agent
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "notify" with prompt "Alert: {commonLabels.alertname} is {status}"
    Then the subscription "notify" appears in the subscriptions list
    And the stored webhook subscriptions include "notify"
    When I POST the payload '{"status":"firing","commonLabels":{"alertname":"HighMemory"}}' to webhook "notify"
    Then the webhook response status is 200
    And a webhook-triggered message containing "Alert: HighMemory is firing" is stored in the conversation

  Scenario: An agent-mode subscription runs the agent and delivers its response
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a webhook subscription named "alerts" with prompt "Ignore the payload. Reply with exactly WEBHOOK_RAN_OK and nothing else. Do not use any tools."
    When I POST the payload '{"status":"firing"}' to webhook "alerts"
    Then the webhook response status is 202
    And a webhook-triggered message containing "WEBHOOK_RAN_OK" is stored in the conversation

  Scenario: A disabled subscription rejects incoming events
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "paused-hook" with prompt "irrelevant"
    And I disable the subscription "paused-hook"
    When I POST the payload '{"a":1}' to webhook "paused-hook"
    Then the webhook response status is 403

  Scenario: Events are rejected while the receiver is disabled
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "gated" with prompt "irrelevant"
    And I disable the webhook receiver via the API
    When I POST the payload '{"a":1}' to webhook "gated"
    Then the webhook response status is 403

  Scenario: Unknown webhook names are rejected
    When I navigate to the webhooks page
    And I enable the webhook receiver
    When I POST the payload '{"a":1}' to webhook "does-not-exist"
    Then the webhook response status is 404
