# Feature 001: Prompt Stacking

## Overview

Prompt Stacking allows users to queue multiple prompts for an agent when it's already processing a message. Instead of blocking or rejecting new prompts, the system maintains a queue that automatically sends the next prompt when the agent becomes available.

## Current System Analysis

### Status Monitoring
- Session status is polled every 2 seconds (`SESSION_POLL_INTERVAL_MS = 2000`)
- Status indicators show agent state with visual feedback:
  - Grey with "-" = not running/stable
  - Green with "0" = running but no queued prompts
- Agent status determined by `session.agentRuntimeStatus` and `session.status`
- Key states: "running", "stable", "starting"

### Message Sending
- `sendMessage(sessionId, content)` function in `src/ui/app.js:5682`
- Calls `postSessionMessage(sessionId, trimmed, "user")`
- No current blocking mechanism when agent is busy
- Messages are sent immediately to the agent endpoint

### Status Indicators
- Multiple variants: bar, pill, small
- Clickable pill variant exists in composer area
- Current display logic in `applyAgentStatusIndicatorState()` at line 5315

## Proposed Architecture

### 1. Prompt Queue State Management

```javascript
// Add to global state object
state: {
  promptQueues: new Map(), // sessionId -> Array<{id, content, timestamp}>
  promptQueueCounter: 0,   // For generating unique prompt IDs
  // ... existing state
}
```

### 2. Enhanced Status Display

Modify status indicators to show queue count:
- Green with "0" = running, no queued prompts  
- Green with "1", "2", etc. = running with N queued prompts
- Clickable to open queue management modal

### 3. Queue Management Modal

Modal interface triggered by clicking status indicator:
- List all queued prompts with preview
- Edit prompt content inline
- Delete specific prompts
- Reorder prompts (drag/drop)
- Add new prompts to queue

### 4. Modified Send Logic

```javascript
const sendMessage = async (sessionId, content) => {
  const session = getSessionById(sessionId);
  if (!session) return;
  
  const isAgentBusy = isSessionActive(session) || 
                     session.agentRuntimeStatus === "running";
  
  if (isAgentBusy) {
    // Add to queue instead of sending immediately
    addToPromptQueue(sessionId, content);
    updateStatusIndicators();
  } else {
    // Send immediately as before
    await sendToAgent(sessionId, content);
  }
};
```

### 5. Queue Processing

Monitor for status changes from "running" -> "stable":
- Check if queue has pending prompts
- Send oldest prompt in queue
- Remove sent prompt from queue
- Update status indicators

## Requirements (Confirmed)

1. **Persistence**: Server-side queue storage for cross-device synchronization
   - Essential for phone/laptop workflow
   - Requires backend API for queue CRUD operations

2. **Queue Size Limits**: Maximum 21 prompts per session
   - Prevents memory issues and maintains UX manageability
   - Show warning when approaching limit

3. **Visual Feedback**: 
   - Same color scheme, only increment the number
   - No color changes for queued prompts
   - Status indicator always clickable to open queue modal

4. **Queue Management**: 
   - Always allow opening queue modal (show empty state when no prompts)
   - FIFO processing order
   - Allow editing/deleting individual prompts in modal

5. **Error Handling**: 
   - If queued prompt fails to send: inject content into textarea
   - Show toast notification to user prompting manual resend
   - Ensures no prompt content is lost

6. **File Attachments**: 
   - Files already converted to text on insert
   - Queue stores the final text content (files persist 24hrs on filesystem)
   - No special handling needed for attachments in queue

## Implementation Plan

### Phase 1: Backend API (Server-side Queue Storage)

1. **New Storage Module**: Create `src/storage/prompt-queue-store.ts`
   ```typescript
   interface QueuedPrompt {
     id: string;
     sessionId: string; 
     content: string;
     timestamp: string;
     order: number;
   }
   ```

2. **Database Schema**: SQLite table structure
   ```sql
   CREATE TABLE prompt_queue (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     content TEXT NOT NULL, 
     timestamp TEXT NOT NULL,
     queue_order INTEGER NOT NULL,
     FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
   );
   ```

3. **API Endpoints** (added to `src/server.ts` session routes):
   - `GET /api/sessions/{id}/queue` - Get queue for session
   - `POST /api/sessions/{id}/queue` - Add prompt to queue (with 21 limit check)
   - `PUT /api/sessions/{id}/queue/{promptId}` - Edit prompt content
   - `DELETE /api/sessions/{id}/queue/{promptId}` - Remove specific prompt  
   - `POST /api/sessions/{id}/queue/next` - Send next queued prompt to agent

### Phase 2: Frontend Queue State Management
1. **State Structure**: Add to global state object
   ```javascript
   state: {
     promptQueues: new Map(), // sessionId -> {prompts: [], maxSize: 21}
     // ... existing state
   }
   ```
2. **Queue Operations**: CRUD functions for local state management
3. **Sync Logic**: Keep frontend state synchronized with backend

### Phase 3: Modified Send Logic
1. **Enhanced `sendMessage()` function**:
   - Check if agent is running/busy
   - If busy: add to queue via API
   - If available: send immediately
2. **Queue Processing**: Monitor status changes for auto-sending
3. **Error Handling**: Fallback to textarea injection + toast

### Phase 4: UI Components

1. **Status Indicator Updates** (`src/ui/app.js`):
   ```javascript
   // Modify applyAgentStatusIndicatorState() around line 5315
   const getQueueCount = (sessionId) => {
     const queue = state.promptQueues.get(sessionId);
     return queue?.prompts?.length || 0;
   };
   
   // Update indicator display logic to show queue count
   indicator.textContent = queueCount > 0 ? queueCount.toString() : 
                          (sessionStatus === "running" ? "0" : "-");
   ```

2. **Queue Management Modal**: 
   - **Modal Structure**: Follow existing pattern (like worktree modal)
     - Overlay with role="dialog", aria-modal="true"
     - Click outside to close (when not submitting)
     - Escape key handler
   
   - **Content Layout**:
     ```html
     <div class="wm-prompt-queue-modal">
       <div class="modal-content">
         <header>
           <h2>Prompt Queue - {sessionName}</h2>
           <button class="close-btn">×</button>
         </header>
         
         <!-- Empty State -->
         <div class="empty-state">No prompts queued</div>
         
         <!-- Queue List -->
         <div class="queue-list">
           <div class="queue-item">
             <div class="prompt-preview">First 100 chars...</div>
             <div class="prompt-actions">
               <button class="edit-btn">Edit</button>
               <button class="delete-btn">Delete</button>
             </div>
           </div>
         </div>
         
         <footer>
           <span class="queue-count">{count}/21 prompts</span>
         </footer>
       </div>
     </div>
     ```

3. **Event Handlers**:
   - Click on status indicator -> `openPromptQueueModal(sessionId)`  
   - Edit prompt -> inline textarea or separate edit modal
   - Delete prompt -> confirm and remove from queue
   - Close modal -> sync state and update indicators

4. **Toast Notifications**: 
   - "Prompt queued" when added to queue
   - "Prompt sent to agent" when auto-processed  
   - "Failed to send prompt" with fallback to textarea
   - "Queue limit reached (21/21)" warning

### Phase 5: Integration & Testing
1. **Cross-device Synchronization**: Test phone/laptop workflow
2. **Error Recovery**: Verify failed prompt injection works
3. **Performance**: Ensure responsive with max queue size (21 prompts)

## Technical Considerations

- Leverage existing status polling for queue processing triggers
- Reuse existing modal infrastructure and patterns
- WebSocket updates for real-time queue synchronization
- Maintain compatibility with existing keyboard shortcuts and UX flows
- File attachment handling already simplified (text-only storage needed)

## Success Criteria

- ✅ Server-side persistence enables cross-device access
- ✅ Max 21 prompts per queue prevents system overload
- ✅ Prompts queued automatically when agent is busy  
- ✅ Queue count displayed on status indicator (same colors)
- ✅ Modal always accessible with empty state support
- ✅ Failed prompts recovered to textarea with toast notification
- ✅ FIFO processing maintains expected prompt order
- ✅ No regression in single-prompt workflows