# React Migration Plan for Wingman V2

## Overview

This document outlines a strategic migration plan for transitioning Wingman V2's UI from vanilla JavaScript to React. The migration will be incremental, minimizing disruption while modernizing the frontend architecture.

## Current State Assessment

### Existing UI Architecture
- Single HTML file (`src/ui/index.html`) with extensive dialog system
- Vanilla JavaScript ES6 modules
- Manual state management across multiple views
- Real-time WebSocket integration
- Complex features: file browser, document editor, terminal integration, authentication flows

### Pain Points Identified
- Large, monolithic HTML structure
- Manual state synchronization between components
- Limited code reusability
- Complex event handling patterns
- Difficult to test UI components

## Migration Strategy: Incremental Hybrid Approach

### Phase 1: Foundation Setup (Week 1-2)

#### 1.1 Build System Preparation
```bash
# Add React and necessary dependencies
bun add react react-dom
bun add -d @types/react @types/react-dom @vitejs/plugin-react vite
```

#### 1.2 Create React Entry Point
- Create `src/ui/react/index.tsx` as new React application root
- Set up Vite configuration for React development
- Configure TypeScript for React components
- Preserve existing vanilla JS entry point

#### 1.3 Establish Coexistence Pattern
- Modify `src/ui/index.html` to support both systems
- Create mount points for React components
- Implement communication layer between vanilla JS and React
- Add feature flags for component-level migration

### Phase 2: Component Extraction (Week 3-6)

#### 2.1 Priority Components for Migration

**High Priority (Week 3-4):**
1. **Session Dialog** (`#session-dialog`)
   - Complex form with validation
   - Multiple dependent fields
   - File system integration
   - Perfect candidate for React Hook Form

2. **File Browser** (`.directory-browser`)
   - Recursive navigation
   - State management for current path
   - Keyboard shortcuts
   - Drag-and-drop functionality

3. **App Dialog** (`#app-dialog`)
   - Multi-step configuration
   - Dynamic field generation
   - Script discovery integration

**Medium Priority (Week 5-6):**
4. **Identity Management** (`.wm-identity-dialog`)
5. **Project Dialog** (`#project-dialog`)
6. **Orchestrator Dialog** (`#orchestrator-dialog`)

#### 2.2 Migration Pattern for Each Component

```typescript
// Component Template
interface ComponentProps {
  // Props from existing vanilla JS integration
  onClose: () => void;
  onSubmit: (data: FormData) => void;
  initialData?: any;
}

export const ReactComponent: React.FC<ComponentProps> = ({
  onClose,
  onSubmit,
  initialData
}) => {
  // Component implementation
  return (
    <div className="existing-css-classes">
      {/* Component JSX */}
    </div>
  );
};
```

#### 2.3 Integration Strategy
- Wrap React components in Web Components for vanilla JS compatibility
- Use custom events for communication between systems
- Maintain existing CSS classes and styling
- Preserve all current functionality during migration

### Phase 3: State Management Modernization (Week 7-8)

#### 3.1 Shared State Architecture
- Implement Zustand for global state management
- Create stores for:
  - Session management
  - User authentication
  - File system state
  - Real-time updates

```typescript
// Example store structure
interface AppState {
  sessions: Session[];
  currentUser: User | null;
  activeFiles: FileState[];
  // ... other state
}

const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  currentUser: null,
  activeFiles: [],
  // ... actions
}));
```

#### 3.2 WebSocket Integration
- Create React hooks for WebSocket connections
- Implement automatic reconnection logic
- Add optimistic updates for better UX

### Phase 4: View Migration (Week 9-12)

#### 4.1 Route-by-Route Migration
1. **Settings Page** (`/settings`) - Simplest, lowest risk
2. **Apps View** (`/apps`) - Medium complexity
3. **Projects View** (`/projects`) - Medium complexity
4. **Home View** (`/home`) - High complexity, critical path
5. **Live View** (`/live`) - Highest complexity, final phase

#### 4.2 React Router Integration
- Add React Router for navigation
- Implement lazy loading for views
- Preserve existing URL structure
- Handle browser history correctly

### Phase 5: Advanced Features (Week 13-14)

#### 5.1 Performance Optimizations
- Implement React.memo for expensive components
- Add virtual scrolling for large lists
- Use Suspense for loading states
- Optimize bundle splitting

#### 5.2 Testing Infrastructure
- Set up React Testing Library
- Create component tests for migrated components
- Add integration tests for critical user flows
- Implement visual regression testing

## Technical Implementation Details

### Build Configuration

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/ui/react/index.tsx'),
      name: 'WingmanReact',
      fileName: (format) => `wingman-react.${format}.js`
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM'
        }
      }
    }
  },
  server: {
    port: 3001 // Separate from main server
  }
});
```

### Component Integration Pattern

```typescript
// Wrapper for vanilla JS integration
class ReactDialogWrapper extends HTMLElement {
  private root: ReactDOM.Root | null = null;
  
  connectedCallback() {
    this.root = ReactDOM.createRoot(this);
    this.root.render(<ReactComponent {...this.props} />);
  }
  
  disconnectedCallback() {
    this.root?.unmount();
  }
}

customElements.define('react-dialog', ReactDialogWrapper);
```

### State Synchronization

```typescript
// Bridge between vanilla JS and React state
class StateBridge {
  private reactStore: any;
  private vanillaState: any;
  
  constructor(reactStore: any, vanillaState: any) {
    this.reactStore = reactStore;
    this.vanillaState = vanillaState;
    this.setupSync();
  }
  
  private setupSync() {
    // Sync vanilla state changes to React
    this.vanillaState.subscribe((state: any) => {
      this.reactStore.setState(state);
    });
    
    // Sync React state changes to vanilla
    this.reactStore.subscribe((state: any) => {
      this.vanillaState.update(state);
    });
  }
}
```

## Risk Mitigation

### Technical Risks
1. **Breaking Existing Functionality**
   - Comprehensive testing before each component migration
   - Feature flags for instant rollback
   - Parallel running of old and new components

2. **Performance Regression**
   - Bundle size monitoring
   - Performance budgets enforced in CI
   - Regular performance audits

3. **State Management Complexity**
   - Gradual state migration
   - Clear separation of concerns
   - Extensive documentation of state flows

### Project Risks
1. **Timeline Overrun**
   - Weekly progress reviews
   - Scope adjustment capability
   - MVP definition for each phase

2. **Team Productivity Loss**
   - Training sessions for React
   - Pair programming for complex migrations
   - Documentation of patterns and best practices

## Success Metrics

### Technical Metrics
- Component reusability index
- Bundle size change (< +20%)
- Performance scores (Lighthouse)
- Test coverage (> 80%)

### Development Metrics
- Feature development velocity
- Bug reduction rate
- Code review time
- Developer satisfaction scores

### User Metrics
- Page load times
- Interaction responsiveness
- Error rates
- User satisfaction feedback

## Rollback Strategy

### Immediate Rollback (< 1 hour)
- Feature flags for each migrated component
- Simple configuration change to revert
- No data loss or corruption risk

### Phase Rollback (< 1 day)
- Git branch management for each phase
- Database schema compatibility
- Clear rollback procedures documented

### Complete Rollback (< 1 week)
- Maintained vanilla JS codebase
- Gradual transition back to old system
- User communication plan

## Timeline Summary

| Phase | Duration | Key Deliverables |
|-------|----------|------------------|
| Foundation | 2 weeks | Build setup, React entry point |
| Component Extraction | 4 weeks | 3-6 key components migrated |
| State Management | 2 weeks | Zustand stores, hooks |
| View Migration | 4 weeks | All major views in React |
| Advanced Features | 2 weeks | Performance, testing |
| **Total** | **14 weeks** | **Fully migrated React UI** |

## Resource Requirements

### Development Team
- 1-2 frontend developers with React experience
- 1 full-stack developer for integration
- Code review time from senior developers

### Tools & Services
- Development environment updates
- CI/CD pipeline modifications
- Testing infrastructure setup
- Performance monitoring tools

## Next Steps

1. **Stakeholder Approval** - Review and approve this migration plan
2. **Team Training** - React workshops and best practices sessions
3. **Environment Setup** - Configure build tools and development environment
4. **Prototype Development** - Build proof of concept with one component
5. **Success Criteria Definition** - Finalize metrics and acceptance criteria

## Conclusion

This incremental migration approach minimizes risk while modernizing the UI architecture. By maintaining the existing vanilla JS system during the transition, we ensure business continuity while building a more maintainable and scalable frontend. The 14-week timeline provides a balance between thoroughness and speed, with clear milestones and rollback options at each stage.
