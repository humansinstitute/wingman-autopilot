Input: <workingdir> will be specified in the prompt

1. Review all code in the directory `~/code` that has changed in the last 24 hours
2. Write a report on all changes that have been made in ~/Documents/Wingman/Daily_Highlight_Reports/YY_MM_DD_Highlights.md
3. Summarise any potential next steps and add to this report
4. Write an additional file to `~/.wingmen/orchestrator/triggers/<sessionId>.json` where <sessionId> is the session ID mentioned in the initial prompt. The include the following details.- be exact 
```
{
    "session": "<sessionId>",
    "action": "stop"
}
```