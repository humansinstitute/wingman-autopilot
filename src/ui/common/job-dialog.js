import { DEFAULT_AGENT, getAgentLabel, populateAgentSelect } from "./agent-options.js";

const emptyText = "--";

const normalizeText = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const formatRefs = (value) => {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
};

const populateSelectOptions = (select, jobs) => {
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = "";
  jobs.forEach((job) => {
    const option = document.createElement("option");
    option.value = job.id;
    option.textContent = job.name || job.id;
    select.append(option);
  });
  if (jobs.some((job) => job.id === previousValue)) {
    select.value = previousValue;
    return;
  }
  select.value = jobs[0]?.id ?? "";
};

export const createJobDialogController = (options) => {
  const {
    dialog,
    jobSelect,
    workerAgentSelect,
    managerAgentSelect,
    workerDirInput,
    managerDirInput,
    goalInput,
    workerGoalInput,
    managerGoalInput,
    extraPromptInput,
    refsInput,
    confirmButton,
    isAuthenticated,
    onRequireAuth,
    loadJobDefinitions,
    onSubmit,
    onDirectoryInput,
    defaultManagerDirOutput,
    defaultWorkerAgentOutput,
    defaultManagerAgentOutput,
    checkIntervalOutput,
    managerGoalOutput,
    workerPromptOutput,
    managerPromptOutput,
    showToast,
  } = options;

  let definitions = [];
  let submitting = false;

  const getSelectedJob = () => {
    const selectedId = jobSelect?.value ?? "";
    return definitions.find((job) => job.id === selectedId) ?? null;
  };

  const syncSummary = () => {
    const job = getSelectedJob();
    if (!job) {
      if (defaultManagerDirOutput) defaultManagerDirOutput.textContent = emptyText;
      if (defaultWorkerAgentOutput) defaultWorkerAgentOutput.textContent = emptyText;
      if (defaultManagerAgentOutput) defaultManagerAgentOutput.textContent = emptyText;
      if (checkIntervalOutput) checkIntervalOutput.textContent = emptyText;
      if (managerGoalOutput) managerGoalOutput.textContent = "No enabled jobs available.";
      if (workerPromptOutput) workerPromptOutput.textContent = emptyText;
      if (managerPromptOutput) managerPromptOutput.textContent = emptyText;
      return;
    }
    if (defaultManagerDirOutput) {
      defaultManagerDirOutput.textContent = normalizeText(job.manager_dir) || emptyText;
    }
    if (defaultWorkerAgentOutput) {
      defaultWorkerAgentOutput.textContent = getAgentLabel(job.worker_agent);
    }
    if (defaultManagerAgentOutput) {
      defaultManagerAgentOutput.textContent = getAgentLabel(job.manager_agent);
    }
    if (checkIntervalOutput) {
      checkIntervalOutput.textContent = `${job.check_interval || 300}s`;
    }
    if (managerGoalOutput) {
      managerGoalOutput.textContent = normalizeText(job.manager_goal) || emptyText;
    }
    if (workerPromptOutput) {
      workerPromptOutput.textContent = normalizeText(job.worker_prompt) || emptyText;
    }
    if (managerPromptOutput) {
      managerPromptOutput.textContent = normalizeText(job.manager_prompt) || emptyText;
    }
  };

  const resetFormState = () => {
    const job = getSelectedJob();
    const defaultDir = normalizeText(job?.manager_dir);
    const workerAgent = normalizeText(job?.worker_agent) || DEFAULT_AGENT;
    const managerAgent = normalizeText(job?.manager_agent) || DEFAULT_AGENT;
    populateAgentSelect(workerAgentSelect, workerAgent);
    populateAgentSelect(managerAgentSelect, managerAgent);
    if (workerDirInput) {
      workerDirInput.value = defaultDir;
      onDirectoryInput?.(defaultDir);
    }
    if (managerDirInput) {
      managerDirInput.value = defaultDir;
      onDirectoryInput?.(defaultDir);
    }
    if (goalInput) goalInput.value = "";
    if (workerGoalInput) workerGoalInput.value = "";
    if (managerGoalInput) managerGoalInput.value = normalizeText(job?.manager_goal);
    if (extraPromptInput) extraPromptInput.value = "";
    if (refsInput) refsInput.value = "";
    syncSummary();
  };

  const updateSubmittingState = () => {
    if (confirmButton) {
      confirmButton.disabled = submitting || definitions.length === 0;
      confirmButton.textContent = submitting ? "Launching..." : "Launch Job";
    }
  };

  const open = async () => {
    if (!isAuthenticated()) {
      onRequireAuth();
      return;
    }
    const data = await loadJobDefinitions();
    definitions = (Array.isArray(data?.jobs) ? data.jobs : []).filter((job) => job && job.enabled !== false);
    populateSelectOptions(jobSelect, definitions);
    resetFormState();
    updateSubmittingState();
    if (!definitions.length) {
      showToast?.("No enabled job definitions are available yet.", { type: "warning" });
      return;
    }
    if (typeof dialog?.showModal === "function") {
      dialog.showModal();
      jobSelect?.focus();
    }
  };

  const close = () => {
    if (dialog?.open) {
      dialog.close();
    }
    submitting = false;
    updateSubmittingState();
  };

  const collectValues = () => ({
    jobId: normalizeText(jobSelect?.value),
    workerAgent: normalizeText(workerAgentSelect?.value) || DEFAULT_AGENT,
    managerAgent: normalizeText(managerAgentSelect?.value) || DEFAULT_AGENT,
    workerDir: normalizeText(workerDirInput?.value),
    managerDir: normalizeText(managerDirInput?.value),
    goal: normalizeText(goalInput?.value),
    workerGoal: normalizeText(workerGoalInput?.value),
    managerGoal: normalizeText(managerGoalInput?.value),
    prompt: normalizeText(extraPromptInput?.value),
    refs: formatRefs(refsInput?.value ?? ""),
  });

  const handleSubmit = async () => {
    if (submitting) return;
    const values = collectValues();
    if (!values.jobId) {
      showToast?.("Select a job before launching.", { type: "warning" });
      jobSelect?.focus();
      return;
    }
    if (!values.workerDir) {
      showToast?.("Worker directory is required.", { type: "warning" });
      workerDirInput?.focus();
      return;
    }
    if (!values.managerDir) {
      showToast?.("Manager directory is required.", { type: "warning" });
      managerDirInput?.focus();
      return;
    }
    submitting = true;
    updateSubmittingState();
    try {
      await onSubmit(values);
      close();
    } catch (error) {
      console.error("Failed to launch job", error);
      showToast?.(`Failed to launch job: ${error instanceof Error ? error.message : String(error)}`, {
        type: "error",
      });
    } finally {
      submitting = false;
      updateSubmittingState();
    }
  };

  jobSelect?.addEventListener("change", () => {
    resetFormState();
  });

  workerDirInput?.addEventListener("input", () => {
    onDirectoryInput?.(workerDirInput.value);
  });

  managerDirInput?.addEventListener("input", () => {
    onDirectoryInput?.(managerDirInput.value);
  });

  return {
    open,
    close,
    handleSubmit,
  };
};
