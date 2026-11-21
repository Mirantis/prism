Feature: Images inside the agent's reply
  As a user of the terminal UI I want to see an image the agent places in its
  reply at its place between the text, drawn where my terminal can draw it

  Scenario: A terminal without kitty graphics shows the image's description
    Given the CLI runs in a terminal that answers only the device attributes
    When I ask the agent to show an image between "PRISMBEFORE" and "PRISMAFTER"
    Then the reply shows the image's description between "PRISMBEFORE" and "PRISMAFTER"

  Scenario: A kitty terminal draws the image with the kitty graphics protocol
    Given the CLI runs in a kitty terminal
    When I ask the agent to show an image between "PRISMBEFORE" and "PRISMAFTER"
    Then the CLI stores the image in the terminal
    And the reply draws the image's placeholders between "PRISMBEFORE" and "PRISMAFTER"
