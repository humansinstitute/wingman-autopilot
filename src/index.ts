import { runSetupWizard } from "./setup/wizard";

const main = async () => {
  const proceed = await runSetupWizard();
  if (!proceed) {
    process.exit(0);
  }
  // Dynamic import after wizard completes so env vars are loaded
  await import("./server");
};

main().catch((error) => {
  console.error("Failed to start Wingman:", error);
  process.exit(1);
});
