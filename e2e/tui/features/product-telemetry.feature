Feature: The product name, the deployment and the token use on product telemetry
  As the operator of a product that launches agents I want its agents' telemetry
  to carry the product's name, so I can filter that product's events from the
  others. As the owner of the fleet metric I want each install to have one id
  across restarts, and each closed hour of model calls reported once. Each
  scenario boots its own runtime, which sends its telemetry to a collector the
  test runs.

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

  Scenario: A runtime keeps its deployment id across a restart
    Given a runtime started without PRODUCT_NAME
    When the runtime reports that the agent started
    And the runtime restarts and reports that the agent started again
    Then both boots have the same non-empty deployment.id

  Scenario: A runtime reports the token use of a closed hour
    Given a runtime started without PRODUCT_NAME
    And the agent made a model call three hours ago that is not reported yet
    When the runtime restarts
    Then the runtime reports the token use of that hour once, metered by the harness
    And its routing matches the agent started event of the same boot
