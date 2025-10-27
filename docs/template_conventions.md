# Orchestrator Template System Implementation Plan

## Overview

This document outlines the complete implementation plan for migrating from the current database-driven orchestrator preset system to a file-based template system using markdown files with YAML frontmatter.

## Current System Analysis

### Existing Architecture
- **Storage**: SQLite database (`orchestrator_presets` table)
- **API**: `/api/orchestrators` endpoint serves preset metadata
- **UI**: Home page renders preset buttons from database
- **Session Creation**: Uses `orchestratorPresetStore.getPreset()` to launch sessions

### Database Schema (to be replaced)
```sql
CREATE TABLE orchestrator_presets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  agent TEXT NOT NULL,
  template_dir TEXT,
  active_root TEXT,
  directory_prefix TEXT,
  working_directory TEXT,
  intro_message TEXT,
  poll_timeout_ms INTEGER DEFAULT 30000,
  poll_interval_ms INTEGER DEFAULT 250,
  retry_attempts INTEGER DEFAULT 10,
  retry_delay_ms INTEGER DEFAULT 1000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## New Template System Specification

### File Structure
```
orchestrator/
├── templates/
│   ├── 01_HighglightReport.md
│   ├── 02_SecurityReview.md
│   └── [future templates].md
└── [subdirectories to be removed after migration]
```

### Template File Format

#### YAML Frontmatter Schema
```yaml
---
Template: "Human Readable Template Name"  # Required: Button label and session name
button: true                             # Required: Whether to show UI button
order: 1                                 # Required: Display order (ascending)
input: [var1, var2, var3]               # Required: Input variables needed
---
```

#### Supported Input Variables
- `prompt`: User-provided text input
- `session_name`: Override for session name (optional)
- `default_agent`: Agent type to use (codex|claude|goose|opencode|gemini)
- `working_directory`: Target directory path

#### Variable Substitution
- Use angle bracket syntax: `<variable_name>`
- Variables in template body will be replaced with actual values
- Missing required variables will cause session creation to fail

#### Example Template
```markdown
---
Template: "Security Review"
button: true
order: 2
input: [prompt, session_name, default_agent, working_directory]
---

In Directory: <working_directory>

1. Review all code in <working_directory> that has changed in the last 24 hours
2. Write a report on all changes that have been made in ~/Documents/Wingman/Security_Reports/YY_MM_DD_Security_Report_<repo>.md
3. Add a section reviewing implementation for potential security issues

Additional instructions from user:
<prompt>
```

## Implementation Plan

### Phase 1: Template Loading Infrastructure

#### 1.1 Create Template Manager Class
**File**: `src/templates/template-manager.ts`

```typescript
interface TemplateMetadata {
  id: string;                    // Generated from filename
  filePath: string;             // Absolute path to template file
  template: string;             // Human readable name
  button: boolean;              // Show in UI
  order: number;                // Display order
  input: string[];              // Required input variables
  content: string;              // Template body (after frontmatter)
}

interface TemplateInput {
  [key: string]: string;        // Variable name -> value mapping
}

class TemplateManager {
  loadTemplates(): TemplateMetadata[]
  getTemplate(id: string): TemplateMetadata | null
  processTemplate(template: TemplateMetadata, input: TemplateInput): string
  validateInput(template: TemplateMetadata, input: TemplateInput): string[]
  watchTemplates(callback: () => void): void
}
```

**Key Functions:**
- `loadTemplates()`: Scan `orchestrator/templates/*.md`, parse frontmatter
- `getTemplate()`: Retrieve specific template by ID
- `processTemplate()`: Replace `<variable>` placeholders with actual values
- `validateInput()`: Return array of missing required variables
- `watchTemplates()`: File system watcher for hot-reload

#### 1.2 YAML Frontmatter Parsing
**Dependencies**: Add `yaml` parser library
```bash
bun add js-yaml @types/js-yaml
```

**Parsing Logic**:
```typescript
import yaml from 'js-yaml';

function parseFrontmatter(content: string): {
  metadata: TemplateMetadata;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('Invalid frontmatter format');
  
  const [, frontmatter, body] = match;
  const parsed = yaml.load(frontmatter) as any;
  
  // Validate required fields
  if (!parsed.Template || typeof parsed.button !== 'boolean' || 
      typeof parsed.order !== 'number' || !Array.isArray(parsed.input)) {
    throw new Error('Missing required frontmatter fields');
  }
  
  return {
    metadata: {
      template: parsed.Template,
      button: parsed.button,
      order: parsed.order,
      input: parsed.input,
      // ... other fields
    },
    body: body.trim()
  };
}
```

#### 1.3 File System Integration
**Directory**: Always scan `<project_root>/orchestrator/templates/`
**Pattern**: `*.md` files only (ignore subdirectories)
**ID Generation**: Use filename without extension as template ID

```typescript
function generateTemplateId(filePath: string): string {
  return path.basename(filePath, '.md');
}
```

### Phase 2: API Layer Updates

#### 2.1 New Templates Endpoint
**Endpoint**: `GET /api/templates`
**Response**:
```json
{
  "templates": [
    {
      "id": "01_HighglightReport",
      "template": "Highlight Report",
      "button": true,
      "order": 1,
      "input": ["prompt", "session_name", "default_agent", "working_directory"]
    },
    {
      "id": "02_SecurityReview", 
      "template": "Security Review",
      "button": true,
      "order": 2,
      "input": ["prompt", "session_name", "default_agent", "working_directory"]
    }
  ]
}
```

#### 2.2 Template Launch Endpoint
**Endpoint**: `POST /api/templates/:id/launch`
**Request Body**:
```json
{
  "input": {
    "prompt": "Review the authentication system",
    "session_name": "Auth Security Review",
    "default_agent": "claude",
    "working_directory": "/Users/dev/myproject"
  }
}
```

**Process Flow**:
1. Load template by ID
2. Validate all required input variables provided
3. Process template content with variable substitution
4. Create agent session with processed content as intro message
5. Return session details

#### 2.3 Server Integration
**File**: `src/server.ts`

```typescript
// Add to server request handling
if (pathname === "/api/templates" && method === "GET") {
  const templates = templateManager.loadTemplates()
    .filter(t => t.button) // Only return templates marked for UI
    .sort((a, b) => a.order - b.order);
  return Response.json({ templates });
}

if (pathname.startsWith("/api/templates/") && method === "POST") {
  const parts = pathname.split('/');
  if (parts[3] === 'launch' && parts[2]) {
    return handleTemplateLaunch(parts[2], request);
  }
}

async function handleTemplateLaunch(templateId: string, request: Request) {
  const payload = await request.json();
  const template = templateManager.getTemplate(templateId);
  
  if (!template) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }
  
  const input = payload.input || {};
  const missingVars = templateManager.validateInput(template, input);
  
  if (missingVars.length > 0) {
    return Response.json({ 
      error: "Missing required variables", 
      missing: missingVars 
    }, { status: 400 });
  }
  
  const processedContent = templateManager.processTemplate(template, input);
  
  // Create session with processed template as intro message
  const session = await manager.createSession(
    input.default_agent as AgentType,
    input.working_directory,
    input.session_name || template.template
  );
  
  // Send processed template as first message
  await sendAgentMessage(agentHost, session.port, processedContent);
  
  return Response.json({ session });
}
```

### Phase 3: UI Updates

#### 3.1 Template Button Rendering
**File**: `src/ui/app.js`

Replace orchestrator preset loading:
```javascript
// Replace existing orchestratorPresets state
const state = {
  // ... existing state
  templates: [],
  templatesLoading: false,
  templatesLoaded: false,
  templatesError: null,
}

// Replace fetchOrchestratorPresets function
const fetchTemplates = async () => {
  if (state.templatesLoading) return;
  
  state.templatesLoading = true;
  state.templatesError = null;
  
  try {
    const response = await fetch("/api/templates");
    const data = await response.json();
    state.templates = data.templates || [];
    state.templatesLoaded = true;
  } catch (error) {
    state.templatesError = error.message;
  } finally {
    state.templatesLoading = false;
  }
};

// Update home page rendering
const renderHomePage = () => {
  // ... existing session management UI
  
  // Add template buttons section
  const templatesSection = document.createElement("section");
  templatesSection.className = "wm-card";
  
  const heading = document.createElement("h2");
  heading.textContent = "Quick Actions";
  templatesSection.append(heading);
  
  if (state.templatesLoading) {
    templatesSection.append(createLoadingIndicator("Loading templates..."));
  } else if (state.templatesError) {
    templatesSection.append(createErrorMessage(state.templatesError));
  } else if (state.templates.length === 0) {
    templatesSection.append(createEmptyMessage("No templates available"));
  } else {
    const buttonContainer = document.createElement("div");
    buttonContainer.className = "template-buttons";
    
    state.templates
      .sort((a, b) => a.order - b.order)
      .forEach(template => {
        const button = document.createElement("button");
        button.className = "wm-button template-button";
        button.textContent = template.template;
        button.addEventListener("click", () => openTemplateDialog(template));
        buttonContainer.append(button);
      });
    
    templatesSection.append(buttonContainer);
  }
  
  return templatesSection;
};
```

#### 3.2 Template Input Dialog
```javascript
const openTemplateDialog = (template) => {
  const dialog = createTemplateDialog(template);
  document.body.append(dialog);
  dialog.showModal();
};

const createTemplateDialog = (template) => {
  const dialog = document.createElement("dialog");
  dialog.className = "template-dialog";
  
  const form = document.createElement("form");
  form.method = "dialog";
  
  const title = document.createElement("h3");
  title.textContent = template.template;
  form.append(title);
  
  const inputContainer = document.createElement("div");
  inputContainer.className = "template-inputs";
  
  // Create input fields based on template.input array
  template.input.forEach(inputName => {
    const fieldContainer = document.createElement("div");
    fieldContainer.className = "field-container";
    
    const label = document.createElement("label");
    label.textContent = formatInputLabel(inputName);
    label.setAttribute("for", `template-${inputName}`);
    
    const input = createInputField(inputName, template);
    input.id = `template-${inputName}`;
    input.name = inputName;
    
    fieldContainer.append(label, input);
    inputContainer.append(fieldContainer);
  });
  
  form.append(inputContainer);
  
  // Action buttons
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "dialog-buttons";
  
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => dialog.close());
  
  const launchButton = document.createElement("button");
  launchButton.type = "submit";
  launchButton.textContent = "Launch";
  launchButton.addEventListener("click", (e) => {
    e.preventDefault();
    handleTemplateLaunch(template, form, dialog);
  });
  
  buttonContainer.append(cancelButton, launchButton);
  form.append(buttonContainer);
  dialog.append(form);
  
  return dialog;
};

const createInputField = (inputName, template) => {
  switch (inputName) {
    case 'prompt':
      const textarea = document.createElement("textarea");
      textarea.placeholder = "Enter additional instructions...";
      textarea.rows = 3;
      return textarea;
    
    case 'default_agent':
      const select = document.createElement("select");
      state.config.agents.forEach(agent => {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.label;
        select.append(option);
      });
      return select;
    
    case 'working_directory':
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.config?.defaultDirectory || "";
      input.placeholder = "Working directory path";
      return input;
    
    case 'session_name':
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = template.template;
      nameInput.placeholder = "Session name";
      return nameInput;
    
    default:
      const defaultInput = document.createElement("input");
      defaultInput.type = "text";
      defaultInput.placeholder = `Enter ${inputName}`;
      return defaultInput;
  }
};

const handleTemplateLaunch = async (template, form, dialog) => {
  const formData = new FormData(form);
  const input = {};
  
  template.input.forEach(inputName => {
    const value = formData.get(inputName);
    if (value && value.trim()) {
      input[inputName] = value.trim();
    }
  });
  
  try {
    const response = await fetch(`/api/templates/${template.id}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to launch template");
    }
    
    const result = await response.json();
    dialog.close();
    dialog.remove();
    
    // Refresh sessions and switch to new session
    await fetchSessions();
    state.activeSessionId = result.session.id;
    renderCurrentPage();
    
  } catch (error) {
    alert(`Failed to launch template: ${error.message}`);
  }
};
```

### Phase 4: Trigger Integration

#### 4.1 Update Trigger System
**File**: Trigger processing logic (location TBD)

When processing triggers, if they specify a template:
```json
{
  "action": "start",
  "template": "02_SecurityReview",
  "input": {
    "prompt": "Focus on authentication vulnerabilities",
    "working_directory": "/path/to/repo",
    "default_agent": "claude"
  }
}
```

**Processing Logic**:
```typescript
async function processTrigger(trigger: any) {
  if (trigger.template) {
    const template = templateManager.getTemplate(trigger.template);
    if (!template) {
      throw new Error(`Template not found: ${trigger.template}`);
    }
    
    const missingVars = templateManager.validateInput(template, trigger.input || {});
    if (missingVars.length > 0) {
      throw new Error(`Missing required variables: ${missingVars.join(', ')}`);
    }
    
    const processedContent = templateManager.processTemplate(template, trigger.input);
    
    // Create session with processed template
    const session = await manager.createSession(
      trigger.input.default_agent,
      trigger.input.working_directory,
      trigger.input.session_name || template.template
    );
    
    await sendAgentMessage(agentHost, session.port, processedContent);
    return session;
  }
  
  // Fall back to existing trigger processing
  return processLegacyTrigger(trigger);
}
```

### Phase 5: Migration & Cleanup

#### 5.1 Database Migration Strategy
Since this is implemented on a feature branch with breaking changes:
1. Keep existing orchestrator preset code until migration complete
2. Add feature flag to switch between systems during development
3. Remove database tables and related code after validation

#### 5.2 File Structure Cleanup
1. Remove subdirectories from `orchestrator/templates/`
2. Migrate any useful content from subdirectories to main template files
3. Update documentation

#### 5.3 Configuration Updates
Update default working directory handling to support template variable substitution.

### Phase 6: Testing Strategy

#### 6.1 Unit Tests
- Template parsing and validation
- Variable substitution logic
- Input validation
- File watching functionality

#### 6.2 Integration Tests
- Template loading from filesystem
- API endpoint responses
- Session creation with template content
- Trigger system integration

#### 6.3 UI Testing
- Template button rendering
- Input dialog functionality
- Form validation and submission
- Error handling and display

## Error Handling

### Template Loading Errors
- Invalid YAML frontmatter: Log error, skip template
- Missing required fields: Log error, skip template
- File read errors: Log error, continue with other templates
- Duplicate template IDs: Log warning, use first occurrence

### Runtime Errors
- Missing template: Return 404 error
- Missing variables: Return 400 error with missing variable list
- Session creation failure: Return 500 error
- Agent communication failure: Return 503 error

### UI Error Handling
- Template loading failure: Show error message in templates section
- Template launch failure: Show alert with error details
- Form validation: Highlight missing required fields
- Network errors: Show retry option

## File Watching Implementation

Use Node.js `fs.watch()` or similar to monitor template directory:
```typescript
import { watch } from 'fs';

class TemplateManager {
  private templates: Map<string, TemplateMetadata> = new Map();
  private watcher: any;
  
  watchTemplates(callback: () => void) {
    this.watcher = watch(TEMPLATES_DIR, { recursive: false }, (eventType, filename) => {
      if (filename?.endsWith('.md')) {
        this.loadTemplates(); // Reload templates
        callback(); // Notify listeners
      }
    });
  }
  
  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
    }
  }
}
```

## Performance Considerations

### Template Caching
- Cache parsed templates in memory
- Only reload when files change
- Debounce file change events to avoid excessive reloading

### UI Updates
- Only re-render template buttons when template list changes
- Cache DOM elements where possible
- Use document fragments for efficient DOM updates

## Security Considerations

### File Access
- Restrict template loading to designated directory only
- Validate file paths to prevent directory traversal
- Sanitize user input in variable substitution

### Variable Substitution
- Use safe string replacement (not eval)
- Validate variable names against allowed pattern
- Escape special characters in user input

## Future Enhancements

### Advanced Templating
- Support for conditional blocks
- Loop constructs for arrays
- Helper functions (date formatting, etc.)

### Template Validation
- Schema validation for frontmatter
- Lint checks for template syntax
- Preview mode for testing templates

### UI Improvements
- Template preview before launch
- Recent templates/favorites
- Template search and filtering
- Bulk template operations

This implementation plan provides a complete roadmap for migrating from the database-driven preset system to a flexible, file-based template system that supports dynamic UI generation and variable substitution.