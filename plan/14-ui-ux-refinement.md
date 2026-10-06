# 14 — UI/UX Refinement & Complete User Experience

> Milestone: [Phase 10 — UI/UX Refinement & Complete User Experience](https://github.com/moadabdou/Kith/milestone/11)
> 
> Transforming the client from "developer functional design" into a cohesive,
> polished, Discord-grade end-to-end application. Design decisions (palette,
> typography, geometry, animations, and layouts) are steered by the user while
> the technical implementation adheres to strict design system modularity,
> zero regressions on 270+ test suites, and clean component isolation.

---

## 1. Overview & Objectives

Throughout Phases 0 through 9, the client evolved as a functional vehicle for
validating backend primitives: WebSockets, presence state machines, ScyllaDB
message streaming, Pion SFU WebRTC voice/video, Rust read-states, and rich
reactions.

While functionally complete, the frontend carries technical and visual debt from
fast iterative cycles:
- **Scattered Styles**: 4,400+ lines in `client/src/index.css` mixed with hardcoded
  hex colors, ad-hoc inline styles, and missing token abstractions.
- **Navigation Chrome**: Flat channel lists lacking collapsible category folders,
  rudimentary server rail hover states, and a static user deck missing status
  selection and settings entry.
- **Chat Ergonomics**: Lacks Discord power-user ergonomics (e.g. `Up` arrow to edit
  last message, empty channel welcoming heroes, refined action toolbars).
- **User Settings & Identity**: No User Settings modal or audio/video device tester;
  Gateway Op 3 (`sendStatusUpdate`) exists in code but is not exposed to the user.
- **Voice Multitasking**: Browsing text channels unmounts the video stage; users
  need a floating Picture-in-Picture (PiP) mini-player to maintain video context.

---

## 2. Issues Breakdown

### Issue #124: `feat(client): design system foundation & unified token engine`
- **Milestone Issue**: [#124](https://github.com/moadabdou/Kith/issues/124)
- **Scope**:
  - Unify all CSS variables into a clean token system (`--bg-surface-*`, `--text-*`,
    `--border-*`, `--accent-*`, `--presence-*`, `--elevation-*`).
  - Eliminate hardcoded inline `style={{ ... }}` blocks from components.
  - Implement Discord-grade custom scrollbar track/thumb styles, focus-visible outlines,
    and a unified tooltip system.
- **User Design Choices**:
  - Theme palette direction (Authentic Discord Dark vs Slate / OLED).
  - Typography font family & hierarchy.
  - Border radius & elevation shadow intensity.

---

### Issue #125: `feat(client): navigation chrome redesign (server rail, channel categories & user deck)`
- **Milestone Issue**: [#125](https://github.com/moadabdou/Kith/issues/125)
- **Scope**:
  - **Server Rail**: Smooth icon hover morphs (circle to rounded square), left white pill
    indicator transition, server separator line, active server halo.
  - **Channel Sidebar**: Collapsible category headers (*TEXT CHANNELS*, *VOICE CHANNELS*)
    with smooth chevron rotation and collapse state; hover-only channel settings & invite icons.
  - **User Deck**: Redesign the bottom profile card with user avatar, presence dot ring,
    username & discriminator tag, micro-buttons for Mute/Deafen with tooltips, and a
    **User Settings Gear button**.
- **User Design Choices**:
  - Category header tracking, weight, and chevron style.
  - Channel row active/hover pill styles.
  - User deck layout & status indicator placement.

---

### Issue #126: `feat(client): chat stream polish, message composer & welcome hero`
- **Milestone Issue**: [#126](https://github.com/moadabdou/Kith/issues/126)
- **Scope**:
  - **Message Stream**: Cozy message layout, timestamp/avatar alignment, hover action
    toolbar with backdrop blur and smooth appearance.
  - **Composer Box**: Rounded pill-style container, attachment upload preview chips,
    clean reply banner with dismiss button.
  - **Power-User Ergonomics**: `Up` arrow in empty input triggers inline edit on user's
    last sent message.
  - **Channel Welcome Hero**: Discord-grade hero banner at the head of channel histories
    ("Welcome to #channel-name!").
  - **Markdown Polish**: Code blocks with copy button, blockquotes, spoiler masks, and
    colored mention pills.
- **User Design Choices**:
  - Message density (cozy vs compact).
  - Code block theme and copy feedback animation.
  - Welcome hero layout and banner art.

---

### Issue #127: `feat(client): user settings center, presence status switcher & modal system`
- **Milestone Issue**: [#127](https://github.com/moadabdou/Kith/issues/127)
- **Scope**:
  - **Presence Status Selector**: Popover menu to set *Online*, *Idle*, *Do Not Disturb*,
    and *Invisible* (wired directly to Gateway Op 3 `sendStatusUpdate`).
  - **User Settings Center**: Dedicated settings modal featuring:
    - *My Account*: Profile details, discriminator, email, member since, logout.
    - *Voice & Video*: Input/output device dropdowns, live mic sensitivity test meter,
      camera preview.
    - *Keybinds*: Keyboard shortcuts reference.
  - **Quick Switcher (`Ctrl+K` / `Cmd+K`)**: Modal to fuzzy search and jump between
    servers and channels.
  - **Modal Standardization**: Unified backdrop blur, scale-in animations, and standard
    dialog headers/footers for all application modals.
- **User Design Choices**:
  - Settings presentation (fullscreen overlay with sidebar vs modal dialog).
  - Status picker trigger (click on avatar vs settings tab).

---

### Issue #128: `feat(client): voice & video stage refinement & floating picture-in-picture (PiP)`
- **Milestone Issue**: [#128](https://github.com/moadabdou/Kith/issues/128)
- **Scope**:
  - **Voice Stage Grid**: Adaptable participant grid, active speaker glow border, avatar
    pulse animations, participant nameplates with audio indicators.
  - **Floating PiP Mini-Player**: When user is connected to voice but navigates away to
    text channels, keep video/screenshare visible in a floating mini-stage with quick
    return and call controls.
  - **In-Call Control Dock**: Floating pill dock with Mute, Deafen, Camera, Screen Share,
    and Disconnect actions.
- **User Design Choices**:
  - Floating PiP dock positioning and size.
  - Active speaker glow styling.
  - Video grid tile aspect ratios and layout transitions.

---

## 3. Verification & Gate Checklist

- [ ] All 5 milestone issues closed and verified.
- [ ] 270+ existing client unit/integration tests continue passing without regression.
- [ ] No layout shift (CLS) regressions on toolbar, reaction pills, or channel lists.
- [ ] Responsive navigation verified on standard desktop and compact viewport widths.
- [ ] Postmortem document written (`postmortems/phase-10-ui-ux.md`).
