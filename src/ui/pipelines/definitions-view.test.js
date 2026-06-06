import { describe, expect, test } from "bun:test";

import { getDefinitionFlowRows, renderDefinitionDetailPage, renderDefinitionsListPage } from "./definitions-view.js";

function makeState(overrides = {}) {
  return {
    definitions: [
      {
        id: "one",
        name: "One",
        description: "First pipeline",
        scope: "user",
        default: false,
        tags: [],
        steps: [],
      },
      {
        id: "two",
        name: "Two",
        description: "Second pipeline",
        scope: "shared",
        default: true,
        tags: ["default"],
        steps: [{ name: "Step", type: "code" }],
      },
    ],
    definitionSearch: "",
    definitionFilter: "all",
    definitionTagFilter: "",
    creatorOpen: false,
    wizardPrompt: "",
    wizardBusy: false,
    wizardResult: null,
    ...overrides,
  };
}

describe("pipeline definition list rendering", () => {
  test("renders the new pipeline creator before the definition list", () => {
    const html = renderDefinitionsListPage(makeState({ creatorOpen: true }));

    expect(html).toContain('data-testid="pipeline-creator"');
    expect(html.indexOf('data-testid="pipeline-creator"')).toBeLessThan(
      html.indexOf('data-testid="pipeline-definition-list"'),
    );
  });

  test("renders definition steps as definitions in and activity out", () => {
    const definition = {
      id: "semantic",
      name: "Semantic",
      description: "Shows display rows",
      scope: "user",
      default: false,
      tags: [],
      steps: [{
        name: "Hydrate",
        type: "code",
        input: { pick: { chat: "$.chat.messageText" } },
        assign: "$.chatContext",
        display: {
          in: [{ label: "Message", path: "$.chat.messageText" }],
          out: [{ label: "Thread", path: "$.thread", source: "output" }],
        },
      }],
    };

    expect(getDefinitionFlowRows(definition.steps[0], "in")).toEqual([
      { name: "Message", value: "chat.messageText" },
    ]);
    expect(getDefinitionFlowRows(definition.steps[0], "out")).toEqual([
      { name: "Thread", value: "output: thread" },
    ]);

    const html = renderDefinitionDetailPage(makeState({ definitions: [definition] }), definition);
    expect(html).toContain("Definitions In");
    expect(html).toContain("Activity Out");
    expect(html).toContain("<code>Message</code>");
    expect(html).toContain("<code>Thread</code>");
  });
});
