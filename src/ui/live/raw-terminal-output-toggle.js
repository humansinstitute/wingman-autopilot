function createTerminalIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("wm-live-raw-output-toggle__icon");

  const shapes = [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M8 10l3 2-3 2" }],
    ["path", { d: "M13 15h4" }],
  ];

  shapes.forEach(([tag, attrs]) => {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) => {
      shape.setAttribute(key, String(value));
    });
    shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", "currentColor");
    shape.setAttribute("stroke-width", "2");
    shape.setAttribute("stroke-linecap", "round");
    shape.setAttribute("stroke-linejoin", "round");
    svg.append(shape);
  });

  return svg;
}

export function createRawTerminalOutputToggle({ visible, onToggle }) {
  const button = document.createElement("button");
  const label = visible ? "Hide raw terminal output" : "Show raw terminal output";
  button.type = "button";
  button.className = "wm-live-raw-output-toggle";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.setAttribute("data-testid", "live-raw-terminal-output-toggle");
  button.append(createTerminalIcon());
  button.addEventListener("click", () => {
    onToggle?.();
  });
  return button;
}
