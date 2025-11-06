const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

const PRIORITY_LABELS = new Map(PRIORITY_OPTIONS.map((option) => [option.value, option.label]));

function formatDisplayDate(isoString) {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function toDateInputValue(isoString) {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  return date.toISOString();
}

function sortTodos(todos) {
  return [...todos].sort((left, right) => {
    if (left.starred === right.starred) {
      const leftDue = getDueTime(left);
      const rightDue = getDueTime(right);
      if (leftDue === rightDue) {
        const leftCreated = getCreatedTime(left);
        const rightCreated = getCreatedTime(right);
        return rightCreated - leftCreated;
      }
      return leftDue - rightDue;
    }
    return left.starred ? -1 : 1;
  });
}

function getDueTime(todo) {
  if (!todo.dueDate) {
    return Number.POSITIVE_INFINITY;
  }
  const time = new Date(todo.dueDate).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function getCreatedTime(todo) {
  const created = todo.createdAt ?? todo.updatedAt ?? 0;
  const time = new Date(created).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export {
  PRIORITY_OPTIONS,
  PRIORITY_LABELS,
  formatDisplayDate,
  toDateInputValue,
  parseDateInputValue,
  sortTodos,
};
