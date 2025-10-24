Input: <workingdir> will be specified in the prompt

1. Review all code in the directory `~/code` that has changed in the last 24 hours
2. Write a report on all changes that have been made in ~/Documents/Wingman/Daily_Highlight_Reports/YY_MM_DD_Highlights.md
3. Summarise any potential next steps and add to this report. Make sure the report clearly lists the specific follow-up actions the next agent should take.
4. Before shutting down this session, prepare a new orchestrator trigger file at `~/.wingmen/orchestrator/triggers/<sessionId>_review.json` (replace `<sessionId>` with the session ID from the initial prompt). Use the exact JSON structure below, setting the `message.content` to greet the agent, explain that the highlight report is ready for review, and explicitly enumerate the next steps you identified in step 3 so they are included in the initial prompt.
```
{ "action": "start", "agent": "codex", "directory": "~/code/wingmen", "name": "Docs review", "message": { "content": "Hello" } }
```
5. Write an additional file to `~/.wingmen/orchestrator/triggers/<sessionId>.json` where <sessionId> is the session ID mentioned in the initial prompt. Include the following details - be exact:
```
{
    "session": "<sessionId>",
    "action": "stop"
}
```
