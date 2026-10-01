Feature: Inbound webhooks
  As a user I want external systems (Alertmanager, PagerDuty, GitHub, ...) to
  trigger my agent by POSTing to a named webhook endpoint, managed from the
  Webhooks page. The receiver starts disabled per scenario (per-scenario DB
  reset), so each scenario enables it first. Deliver-only subscriptions render
  the payload template straight into the conversation with no LLM call; the
  agent-mode scenario exercises a real Bedrock run end-to-end. Sender
  verification is generic — the scenarios configure a header, a prefix and a
  secret, which is how any real sender (GitHub, PagerDuty, Alertmanager, …) is
  expressed.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Enable the webhook receiver from its disabled default
    When I navigate to the webhooks page
    Then the webhook receiver switch is off
    And the webhook port is closed
    When I enable the webhook receiver
    Then the stored webhook receiver state is enabled
    And the webhook port is listening

  Scenario: New subscriptions require a shared token by default
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I open a new webhook subscription named "default-token"
    Then the webhook form requires shared-token credentials
    When I create the webhook with header "Authorization" and secret "demo-token" using Enter
    And I POST the payload '{"status":"ok"}' to webhook "default-token"
    Then the webhook response status is 401
    When I POST the payload '{"status":"ok"}' to webhook "default-token" with header "Authorization" set to "demo-token"
    Then the webhook response status is 200

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
    Then the webhook response status is 401

  Scenario: Disabling the receiver closes its port and preserves subscriptions
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "gated" with prompt "irrelevant"
    And I disable the webhook receiver
    Then the webhook receiver switch is off
    And the webhook port is closed
    And the subscription "gated" appears in the subscriptions list
    When I enable the webhook receiver
    And I POST the payload '{"a":1}' to webhook "gated"
    Then the webhook response status is 200

  Scenario: Unknown webhook names are rejected
    When I navigate to the webhooks page
    And I enable the webhook receiver
    When I POST the payload '{"a":1}' to webhook "does-not-exist"
    Then the webhook response status is 401

  Scenario: A signed subscription accepts a correctly signed delivery
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "signed" verified by HMAC header "X-Hub-Signature-256" prefix "sha256=" with secret "s3cret" and prompt "Signed alert: {status}"
    Then the stored webhook subscription "signed" has a secret set and never returns it
    When I POST the payload '{"status":"firing"}' to webhook "signed" signed with secret "s3cret"
    Then the webhook response status is 200
    And a webhook-triggered message containing "Signed alert: firing" is stored in the conversation

  Scenario: A signed subscription rejects an unsigned or tampered delivery
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "guarded" verified by HMAC header "X-Hub-Signature-256" prefix "sha256=" with secret "s3cret" and prompt "Should never appear: {status}"
    When I POST the payload '{"status":"firing"}' to webhook "guarded"
    Then the webhook response status is 401
    When I POST the payload '{"status":"firing"}' to webhook "guarded" signed with secret "wrong-secret"
    Then the webhook response status is 401
    And no webhook-triggered message containing "Should never appear" is stored in the conversation

  Scenario: A token-verified subscription accepts the shared token in a header
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "tokened" verified by token header "Authorization" prefix "Bearer " with secret "s3cret" and prompt "Token alert: {status}"
    When I POST the payload '{"status":"firing"}' to webhook "tokened" with header "Authorization" set to "Bearer s3cret"
    Then the webhook response status is 200
    And a webhook-triggered message containing "Token alert: firing" is stored in the conversation
    When I POST the payload '{"status":"firing"}' to webhook "tokened" with header "Authorization" set to "Bearer nope"
    Then the webhook response status is 401

  Scenario: Manage authentication on a narrow screen with the keyboard
    When I use a narrow webhook viewport
    And I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "mobile-hook" verified by HMAC header "X-Hub-Signature-256" prefix "sha256=" with secret "s3cret" and prompt "Mobile alert: {status}"
    Then the subscription "mobile-hook" shows authentication and controls without horizontal scrolling
    When I open authentication for webhook "mobile-hook" on a short screen
    Then the webhook authentication form and its actions fit the viewport
    When I clear and restore the webhook authentication header
    And I save webhook authentication with an empty secret using Enter
    And I POST the payload '{"status":"kept"}' to webhook "mobile-hook" signed with secret "s3cret"
    Then the webhook response status is 200
    When I open authentication for webhook "mobile-hook" on a short screen
    And I replace the webhook secret with "rotated-secret" using Enter
    And I POST the payload '{"status":"old"}' to webhook "mobile-hook" signed with secret "s3cret"
    Then the webhook response status is 401
    When I POST the payload '{"status":"rotated"}' to webhook "mobile-hook" signed with secret "rotated-secret"
    Then the webhook response status is 200
