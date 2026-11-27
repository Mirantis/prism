Feature: Inbound webhooks
  As a user I want external systems (Alertmanager, PagerDuty, GitHub, ...) to
  trigger my agent by POSTing to a named webhook endpoint, managed from the
  Webhooks page. The receiver starts disabled per scenario (per-scenario DB
  reset), so each scenario enables it first. Deliver-only subscriptions render
  the payload template straight into the conversation with no LLM call; the
  agent-mode scenarios exercise a real Bedrock run end-to-end, including the
  delivery gate that holds a reply with nothing to report and the None target
  that posts nothing at all. Sender
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
    When I navigate to the activity page
    Then the webhook run "notify" is listed as "Delivered"

  # The user sees the posted message alone, and the agent can name the subscription that sent it.
  Scenario: An agent-mode subscription runs the agent, which posts its message
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a webhook subscription named "lunar-relay" with prompt "Ignore the payload. Reply with exactly WEBHOOK_RAN_OK and nothing else."
    When I POST the payload '{"status":"firing"}' to webhook "lunar-relay"
    Then the webhook response status is 202
    And a webhook-triggered message reading exactly "WEBHOOK_RAN_OK" is stored in the conversation
    When I navigate to the activity page
    Then the webhook run "lunar-relay" is listed as "Completed"
    When I navigate to the agent chat page
    Then I should see the message "WEBHOOK_RAN_OK" in the conversation
    When I type "Which webhook subscription sent your last message? Reply with its name only. Do not use any tools." in the chat input
    And I send the message
    Then the agent reply contains "lunar-relay"

  # Three deliveries inside the window get one agent run, and the Activity page
  # names the run that handled each of them.
  Scenario: An agent-mode subscription with a coalescing window runs the agent once for a burst
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a webhook subscription named "burst" with a 5 second coalescing window and prompt "Ignore the payload. Reply with exactly WEBHOOK_BURST_OK and nothing else."
    When I POST the payload '{"status":"firing"}' to webhook "burst" 3 times
    Then the webhook response status is 202
    And a webhook-triggered message reading exactly "WEBHOOK_BURST_OK" is stored in the conversation
    When I navigate to the activity page
    Then the webhook run "burst" is listed as "Completed"
    And 2 runs of webhook "burst" are handled with an earlier event

  Scenario: An agent-mode run with nothing to report posts nothing
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a webhook subscription named "quiet" with prompt "The alert status is {status}. Message me only when the status is firing."
    When I POST the payload '{"status":"resolved"}' to webhook "quiet"
    Then the webhook response status is 202
    When I navigate to the activity page
    Then the webhook run "quiet" is listed as "Nothing to report"
    And no webhook-triggered message is stored in the conversation

  Scenario: A subscription delivered to None runs the agent and posts nothing
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I fill in a webhook subscription named "silent" delivered to "None" with prompt "Ignore the payload. Reply with exactly WEBHOOK_RAN_OK and nothing else. Do not use any tools."
    Then the deliver-only option is unavailable
    When I submit the webhook subscription "silent"
    And I POST the payload '{"status":"firing"}' to webhook "silent"
    Then the webhook response status is 202
    And the agent has run for the webhook
    When I navigate to the activity page
    Then the webhook run "silent" is listed as "Nothing to report"
    And no webhook-triggered message is stored in the conversation

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

  # Some senders check the endpoint with a HEAD request before they save it,
  # and sign the body followed by the endpoint URL.
  Scenario: A subscription whose sender signs the body and the URL accepts a matching delivery
    When I navigate to the webhooks page
    And I enable the webhook receiver
    Then a HEAD request to webhook "boards" answers 200
    When I create a deliver-only webhook subscription named "boards" verified by a sha1 base64 HMAC in header "X-Trello-Webhook" that signs the URL "https://prism.example.com/agents/webhooks/boards", with secret "s3cret" and prompt "Board event: {action.type}"
    And I POST the payload '{"action":{"type":"createCard"}}' to webhook "boards" with header "X-Trello-Webhook" set to a sha1 base64 HMAC of the body alone using secret "s3cret"
    Then the webhook response status is 401
    When I POST the payload '{"action":{"type":"createCard"}}' to webhook "boards" with header "X-Trello-Webhook" set to a sha1 base64 HMAC of the body followed by "https://prism.example.com/agents/webhooks/boards" using secret "s3cret"
    Then the webhook response status is 200
    And a webhook-triggered message containing "Board event: createCard" is stored in the conversation

  Scenario: A token-verified subscription accepts the shared token in a header
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "tokened" verified by token header "Authorization" prefix "Bearer " with secret "s3cret" and prompt "Token alert: {status}"
    When I POST the payload '{"status":"firing"}' to webhook "tokened" with header "Authorization" set to "Bearer s3cret"
    Then the webhook response status is 200
    And a webhook-triggered message containing "Token alert: firing" is stored in the conversation
    When I POST the payload '{"status":"firing"}' to webhook "tokened" with header "Authorization" set to "Bearer nope"
    Then the webhook response status is 401

  Scenario: Edit a subscription's template and event filter
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "editable" with prompt "Before edit: {status}"
    When I edit webhook "editable"
    Then the webhook edit form shows the prompt "Before edit: {status}"
    When I change the webhook prompt to "After edit: {status}" and the events to "deploy" and save
    Then the stored webhook subscription "editable" has the prompt "After edit: {status}" and the events "deploy"
    When I POST the payload '{"event_type":"build","status":"filtered"}' to webhook "editable"
    And I POST the payload '{"event_type":"deploy","status":"done"}' to webhook "editable"
    Then a webhook-triggered message containing "After edit: done" is stored in the conversation
    And no webhook-triggered message containing "filtered" is stored in the conversation

  # The channels are linked rows in the agent's database: this suite runs with
  # no Slack connection. Delivery to real channels is in the Slack suite.
  Scenario: Choose the linked Slack channels a Slack delivery posts to
    Given the agent has the linked Slack channels "release-notes" and "ios-testflight"
    When I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "release" that posts to the Slack channel "ios-testflight"
    Then the stored webhook subscription "release" posts to the Slack channels "ios-testflight"
    And the subscription "release" lists the Slack channels "#ios-testflight"
    When I edit webhook "release"
    And I check the Slack channel "release-notes" and save
    Then the stored webhook subscription "release" posts to the Slack channels "ios-testflight, release-notes"

  Scenario: Manage authentication on a narrow screen with the keyboard
    When I use a narrow webhook viewport
    And I navigate to the webhooks page
    And I enable the webhook receiver
    And I create a deliver-only webhook subscription named "mobile-hook" verified by HMAC header "X-Hub-Signature-256" prefix "sha256=" with secret "s3cret" and prompt "Mobile alert: {status}"
    Then the subscription "mobile-hook" shows authentication and controls without horizontal scrolling
    When I edit webhook "mobile-hook" on a short screen
    Then the webhook edit form and its actions fit the viewport
    When I clear and restore the webhook authentication header
    And I save the webhook edit with an empty secret using Enter
    And I POST the payload '{"status":"kept"}' to webhook "mobile-hook" signed with secret "s3cret"
    Then the webhook response status is 200
    When I edit webhook "mobile-hook" on a short screen
    And I replace the webhook secret with "rotated-secret" using Enter
    And I POST the payload '{"status":"old"}' to webhook "mobile-hook" signed with secret "s3cret"
    Then the webhook response status is 401
    When I POST the payload '{"status":"rotated"}' to webhook "mobile-hook" signed with secret "rotated-secret"
    Then the webhook response status is 200
