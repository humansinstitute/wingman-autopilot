# Wingman UI Brand Spec

This document codifies the current Wingman visual and interaction language so new surfaces feel cohesive with the existing web console. Treat it as the source of truth when designing or implementing UI changes.

## Brand Overview

- **Purpose**: Provide a persistent, remote-access co-pilot for AI workflows so operators can steer agents from anywhere without friction.
- **Tagline**: _Solvitur Ambulando_ - solutions emerge in motion; the interface should feel like a capable companion keeping pace, freeing you from your desk.
- **Brand traits**: Supportive co-pilot, confidence without bravado, pragmatic futurism, resilient craft.
- **Audience**: Developers, operators, and technical founders who expect clarity, speed, and observability in their automation stack.

## Voice & Tone

- Speak in short, affirmative sentences that sound like a trusted flight lead or mission controller.
- Balance friendly metaphors ("wingman", "goose", "sortie") with precise operational language when surfacing system state.
- Use humor sparingly; clever copy is welcome in empty states or onboarding, but status/errors stay direct.
- Prefer verbs that imply motion (launch, resume, monitor) to reinforce the brand thesis.

## Logo & Iconography

- **Primary mark**: `public/Wingman_Goose_Logo.png` (goose with flight goggles). Use on neutral or light surfaces.
- **Inverse mark**: `public/Wingman_Goose_Logo_Dark.png` for dark backgrounds; `public/Wingman_Goose_Logo_Light.png` for light/transparent contexts such as favicons.
- **Clear space**: Maintain padding equal to 25% of the logo height on all sides; never crop the wing silhouette.
- **Minimum sizes**: 32 px for favicons, 48 px for navigation headers, 96 px for hero or splash contexts.
- **Motion**: Micro-interactions may scale the logo up to 110% (as in the header hover), but avoid rotation or bounce.
- Iconography elsewhere should echo the mark's rounded-corner geometry; prefer stroked line icons with 2 px weight.

## Color System

Wingman uses paired light and dark themes driven by CSS variables in `public/index.html`. Preserve the variable names when extending the palette.

### Core Flight Deck

| Token                          | Hex       | Name             | Usage                                            |
| ------------------------------ | --------- | ---------------- | ------------------------------------------------ |
| `--accent-primary`             | `#059669` | Wingman Emerald  | Primary CTAs, active states, data highlights     |
| `--accent-secondary`           | `#047857` | Deep Emerald     | Hover/pressed states, emphasized outlines        |
| `--accent-tertiary`            | `#065f46` | Hangar Green     | Secondary buttons, subtle dividers in light mode |
| Dark theme `--accent-primary`  | `#10b981` | Afterburner Mint | Primary CTAs in dark mode                        |
| Dark theme `--accent-tertiary` | `#34d399` | Guidance Lime    | Inline highlights, charts, success pills         |

### Neutral Runway

| Token                 | Hex                                                  | Intent                    |
| --------------------- | ---------------------------------------------------- | ------------------------- |
| `--bg-gradient-start` | `#f9f9f9` (light) / `#0a0a0a` (dark)                 | Page-level gradient start |
| `--bg-gradient-end`   | `#f5f5f0` / `#1c1917`                                | Page-level gradient end   |
| `--bg-primary`        | `#ffffff` / `#1c1917`                                | Panels, header            |
| `--bg-secondary`      | `#fafaf9` / `#292524`                                | Cards, chat threads       |
| `--bg-tertiary`       | `#f5f5f4` / `#44403c`                                | Inputs, code panes        |
| `--text-primary`      | `#1c1917` / `#f5f5f4`                                | Headlines, labels         |
| `--text-secondary`    | `#44403c` / `#e7e5e4`                                | Body copy                 |
| `--text-tertiary`     | `#57534e` / `#d6d3d1`                                | Metadata, timestamps      |
| `--border-primary`    | `#e7e5e4` / `#44403c`                                | Card outlines             |
| `--shadow-md`         | `rgba(5, 150, 105, 0.2)` / `rgba(16, 185, 129, 0.2)` | Emphasized surfaces       |

### Status & Feedback

| Intent  | Hex                                            | Notes                                    |
| ------- | ---------------------------------------------- | ---------------------------------------- |
| Success | `#10b981` (dark accent) / `#d1fae5` background | Use for completed jobs, live connections |
| Warning | `#f59e0b` with `#fef3c7` background            | Pending attention, queued tasks          |
| Danger  | `#dc2626` base, `#b91c1c` active               | Terminate, delete, irreversible actions  |
| Info    | `#3b82f6` with `#dbeafe` background            | System notices, queued updates           |

### Usage Guidelines

- Keep primary surfaces low-contrast so emerald accents draw the eye.
- When layering states, respect a minimum contrast ratio of 4.5:1 for text against background.
- Gradients should remain vertical and subtle; avoid diagonal blends unless showcasing data visualizations.

## Typography

- **Primary stack**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif`.
- **Headings**: Semi-bold (600) with tight letter-spacing; H1 at 24 px, H2 at 20 px, H3 at 16 px.
- **Body**: 14 px regular (400) line height 1.5. Never drop below 13 px for legibility.
- **Monospace**: Default browser monospace (or `ui-monospace, SFMono-Regular`) for logs and code panes; pair with `--code-bg` (`#1c1917` light / `#000000` dark).
- Apply uppercase sparingly-use for badges or flight labels, not long-form copy.

## Layout & Components

- **Header**: Fixed-height bar with logo on the left and control cluster on the right. Maintain 16 px vertical padding and 24 px horizontal gutter.
- **Panels/Cards**: Use 8 px corner radius, `--shadow-sm` on hover, and `--bg-secondary` for differentiation. Primary CTAs align right within card footers.
- **Chat Threads**: Alternate row shading with `--bg-secondary` and `--bg-tertiary`; inline code inherits `--inline-code-bg` (`#f5f5f4` / `#292524`) and accent text color.
- **Tables & Lists**: Zebra striping uses `rgba(5, 150, 105, 0.05)` overlays on light backgrounds or `rgba(16, 185, 129, 0.1)` on dark.
- **Buttons**: Rounded 6 px corners. Primary uses `--accent-primary` with white text; hover darkens to `--accent-secondary`. Destructive buttons adopt danger red with white text.

## Motion & Interaction

- Default transition duration: 200-300 ms with ease-in-out curve.
- Theme toggle animates background/foreground variables; avoid flashing by keeping gradients subtle.
- Use gentle scale (<=1.02) or elevation shifts on hover; never animate color saturation for accessibility.
- Live status indicators pulse via opacity keyframes between 60-100% to imply breathing equipage, not urgent flashing.

## Accessibility

- Ensure 44 px minimum hit targets for interactive elements, especially mobile.
- Provide dual-theme parity: every new component must declare both light and dark tokens.
- Maintain ARIA roles for chat transcripts, terminal output, and recipe lists to support screen readers.
- Use sentence case for labels and avoid jargon in critical alerts.

## Tone Integration Examples

- **Success toast**: "Session resumed. We're on your wing." (Friendly, concise)
- **Warning banner**: "Scheduler is paused. Resume to keep sorties on schedule." (Actionable)
- **Error modal**: "Goose agent timed out. Retry the command or check connection." (Direct, avoids blame)

## Implementation Notes

- Source tokens live inline within `public/index.html`, `public/recipes.html`, and sibling static pages; extract to a shared CSS module when refactoring.
- Keep favicon swaps in sync with theme toggles by respecting the `body.dark-theme` class that manages icon visibility.
- Reuse CTA classes across CLI and web to reinforce the single-brand feel; align new modules under `src/recipes/` or `src/server/` with these tokens.
- Before launch, validate changes with `npm run web` and smoke test both themes for contrast and hover states.

---

Last updated: 2025-10-16 - replace with the shipping date of your next major UI refresh.
