Feature: The product name on product telemetry
  As the operator of a product that launches agents I want its agents' telemetry
  to carry the product's name, so I can filter that product's events from the
  others. Each scenario boots its own runtime, which sends its telemetry to a
  collector the test runs.

  Scenario: A runtime started with PRODUCT_NAME tags its telemetry with it
    Given a runtime started with PRODUCT_NAME "e2e-product"
    When the runtime reports that the agent started
    Then the telemetry resource has product.name "e2e-product"
    And the telemetry resource keeps service.name "prism-agent-runtime" and service.namespace "prism-agent"

  Scenario: A runtime started without PRODUCT_NAME sends no product name
    Given a runtime started without PRODUCT_NAME
    When the runtime reports that the agent started
    Then the telemetry resource has no product.name
    And the telemetry resource keeps service.name "prism-agent-runtime" and service.namespace "prism-agent"
