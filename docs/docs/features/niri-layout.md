---
sidebar_position: 14
---

# Niri Layout

Atoo Studio includes a **Niri-style** workspace layout inspired by the [Niri](https://github.com/niri-wm/niri) scrollable-tiling Wayland compositor. It arranges IDE panels as windows inside resizable columns on an infinite horizontal strip, giving you full control over your workspace arrangement.

## Activating Niri Layout

Click the **layout toggle button** in the top bar. It cycles through three modes:

| Click | Layout |
|-------|--------|
| 1st | Classic |
| 2nd | Carousel |
| 3rd | **Niri** |

The button label shows the current mode (e.g. `⊟ Niri`). Your layout choice is saved per project.

## Core Concepts

### The Strip

Your workspace is an **infinite horizontal strip** of columns. Columns extend to the left and right — if they exceed the viewport width, you scroll horizontally to reach them. This means panels never get squished to fit the screen.

### Columns

Each column occupies a portion of the screen width and contains one or more **windows** (panels) stacked vertically. You can have as many columns as you need.

### Windows

A window is any IDE panel placed inside a column. Available panel types:

| Panel | Icon | Description |
|-------|------|-------------|
| Files | 📁 | File tree explorer |
| Git | ⎇ | Git branch, commit history, and actions |
| Editor | ✎ | Code editor with file tabs |
| Agent TUI | ▶ | Agent session terminal (one per session) |
| Agent Chat | 💬 | Agent session chat view |
| Terminal | ⬛ | Shell terminal instance |
| Preview | ⬒ | App preview panel |
| Sessions | ◎ | Session list and management |
| Issues | ⊙ | GitHub issues |
| Pull Requests | ⤮ | GitHub pull requests |
| Changes | △ | Project change tracking |

### Default Layout

When you first switch to Niri, you get three columns:

```
[ Files + Git (1/3) ]  [ Editor (1/2) ]  [ Sessions (1/3) ]
```

## Keyboard Shortcuts

All keyboard shortcuts are disabled when focus is inside an input field, textarea, or select element.

### Navigation

| Shortcut | Action |
|----------|--------|
| `Alt + Left` | Focus the column to the left |
| `Alt + Right` | Focus the column to the right |
| `Alt + Up` | Focus the window above in the current column |
| `Alt + Down` | Focus the window below in the current column |

When you navigate to a column, the strip automatically scrolls to center it in view.

### Window Management

| Shortcut | Action |
|----------|--------|
| `Alt + Shift + Left` | **Consume left** — move the focused window into the column to its left (stacks it vertically there) |
| `Alt + Shift + Right` | **Consume right** — move the focused window into the column to its right |
| `Alt + Shift + E` | **Expel** — move the focused window out of its column into a new column to its right (only works when the column has 2+ windows) |

### Column Sizing

| Shortcut | Action |
|----------|--------|
| `Alt + F` | Cycle the focused column's width preset: `1/3` → `1/2` → `2/3` → `full` → `1/3` ... |

### Overview

| Shortcut | Action |
|----------|--------|
| `Ctrl + Shift + O` | Toggle **overview mode** — zooms out to show all columns at once |

## Mouse Interactions

### Scrolling

- **Mouse wheel** on the strip scrolls horizontally (vertical wheel delta is translated to horizontal scroll)
- The strip uses smooth scroll behavior

### Resizing Columns

Drag the **vertical splitter bar** (5px wide) between any two columns to resize them. Both columns switch to custom width mode when dragged. Minimum column width is 150px.

### Resizing Windows Within a Column

When a column contains multiple windows, drag the **horizontal splitter bar** (5px tall) between them to adjust how much vertical space each window gets.

### Focus

- **Click** a window to focus it (blue focus ring appears)
- **Click** a column background to focus that column

### Adding Panels

Click the **+** button in any column header to open the panel picker dropdown. It lists:

- All static panel types (Files, Git, Editor, Preview, Sessions, Issues, Pull Requests, Changes)
- Active agent sessions (dynamically listed)
- Open terminals (dynamically listed)

Selecting a panel creates a **new column** to the right of the clicked column containing that panel.

There is also a large **+** button at the far right of the strip to append a new column at the end.

### Window Header Actions

Each window has a header bar showing its type icon, label, and a close button (appears on hover).

**Right-click** a window header for a context menu with:

| Action | Description |
|--------|-------------|
| Move to left column | Consumes the window into the column to its left |
| Move to right column | Consumes the window into the column to its right |
| Expel to new column | Moves the window into a new column (only shown when column has 2+ windows) |
| Close | Removes the window (and its column if it was the last window) |

### Closing Windows

- Hover over a window header and click the **X** button
- Or right-click the header and select **Close**

When you close the last window in a column, the column is automatically removed.

## Overview Mode

Overview mode zooms out the entire strip so all columns are visible at once. This is useful for getting a bird's-eye view of your workspace and quickly jumping to a different column.

### How to Use

1. Press `Ctrl + Shift + O` or click the **⊡** button in the toolbar
2. All columns are visible, scaled down to fit the viewport
3. Column labels appear at the bottom showing what panels each column contains
4. **Click** any column label (or the column itself) to focus it and exit overview
5. The focused column's label is highlighted with a blue border

The zoom scale is calculated automatically: `min(1, viewport_width / total_strip_width)`.

## Toolbar

The Niri layout replaces the standard sidebar with a compact **toolbar** — a narrow icon strip (40px wide or tall) at the edge of the workspace.

### Toolbar Buttons

| Button | Icon | Action |
|--------|------|--------|
| Sidebar | ☰ | Toggle the project sidebar as a slide-out overlay |
| Overview | ⊡ | Toggle overview mode (highlighted when active) |
| Move toolbar | ⇄ | Cycle toolbar position: left → right → top → bottom |

### Toolbar Position

The toolbar can be placed on any edge. Click the **⇄** button to cycle through positions:

- **Left** (default) — vertical strip on the left edge
- **Right** — vertical strip on the right edge
- **Top** — horizontal strip along the top
- **Bottom** — horizontal strip along the bottom

### Project Sidebar Overlay

Since the standard sidebar is hidden in Niri mode, you access the project list through the **☰** button. This opens the full sidebar as a slide-out overlay:

- The overlay appears on the same edge as the toolbar
- **Click outside** the overlay to close it
- Press **Escape** to close it
- All sidebar features work normally (project switching, worktrees, etc.)

## Column Width Modes

Each column has a width mode displayed in its header:

| Mode | Width |
|------|-------|
| `1/3` | One-third of the available viewport (minus toolbar) |
| `1/2` | Half the available viewport |
| `2/3` | Two-thirds of the available viewport |
| `full` | Full available viewport width |
| `custom` | Pixel value set by dragging splitters (shown as e.g. `523px`) |

Use `Alt + F` to cycle through the preset modes, or drag splitters for pixel-precise custom widths.

## Consume and Expel

These are the key operations for organizing windows, borrowed directly from Niri's window management model.

### Consume

**Move a window into an existing column's vertical stack.**

- Keyboard: `Alt + Shift + Left/Right` moves the focused window into the adjacent column
- Context menu: Right-click the window header → "Move to left/right column"
- The window is appended at the bottom of the target column
- All windows in the affected columns get equal height fractions
- If the source column becomes empty, it is removed

### Expel

**Move a window out of a stack into its own new column.**

- Keyboard: `Alt + Shift + E`
- Context menu: Right-click the window header → "Expel to new column"
- Only available when the column has 2 or more windows
- The new column is created to the right with a default width of `1/3`
- The remaining windows in the source column get recalculated equal heights

## Persistence

Your entire Niri layout is saved automatically per project:

- Column arrangement and order
- Window types, parameters, and height fractions within each column
- Column width modes and custom pixel widths
- Focused column and window indices
- Overview mode state
- Toolbar position

Settings are auto-saved every 5 seconds and on page unload. When you switch back to a project, the layout is restored exactly as you left it.

## Tips

- **Start with the default layout** and add/rearrange as you go — you don't need to configure everything upfront
- Use **overview mode** (`Ctrl + Shift + O`) when you have many columns and want to quickly jump to one
- **Stack related panels** in one column using consume — e.g. put Files + Git together, or an Agent TUI + Terminal side by side vertically
- Use **width presets** (`Alt + F`) for quick sizing instead of dragging splitters
- The **mouse wheel scrolls horizontally** — no need to use the scrollbar
- **Right-click window headers** for quick move/close operations
- Switch between layouts freely — your Classic, Carousel, and Niri layouts are all saved independently
