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
    checkIntervalOutput,
    managerGoalOutput,
    workerPromptOutput,
    managerPromptOutput,
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
      if (checkIntervalOutput) checkIntervalOutput.textContent = emptyText;
      if (managerGoalOutput) managerGoalOutput.textContent = "No enabled jobs available.";
      if (workerPromptOutput) workerPromptOutput.textContent = emptyText;
      if (managerPromptOutput) managerPromptOutput.textContent = emptyText;
      return;
    }
    if (defaultManagerDirOutput) {
      defaultManagerDirOutput.textContent = normalizeText(job.manager_dir) || emptyText;
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
      window.alert("No enabled job definitions are available yet.");
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
      window.alert("Select a job before launching.");
      jobSelect?.focus();
      return;
    }
    if (!values.workerDir) {
      window.alert("Worker directory is required.");
      workerDirInput?.focus();
      return;
    }
    if (!values.managerDir) {
      window.alert("Manager directory is required.");
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
      window.alert(`Failed to launch job: ${error instanceof Error ? error.message : String(error)}`);
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
