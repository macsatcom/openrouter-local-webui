# Light Theme Design

## Overview
Add a light color theme as a complement to the existing dark theme, with a dropdown in the header to switch between them.

## Implementation

### CSS
- Add `data-theme="dark"` as default on `<html>` element
- Add `[data-theme="light"]` CSS rule block with light color variable overrides
- All 21 CSS custom properties get light-appropriate values
- Accent color slightly darkened (#b8935f) for contrast on white backgrounds

### HTML Changes (index.html, image.html, admin.html)
- Add `<select>` with "Dark" / "Light" options in `.user-info` div, next to username
- Set `data-theme` attribute on `<html>` based on stored preference

### JavaScript
- Store theme preference in localStorage key: `theme`
- On page load: read `theme` from localStorage, apply to `document.documentElement.dataset.theme`
- On dropdown change: update localStorage and apply immediately
- Apply before page renders to avoid flash

### Light Theme Color Palette
| Variable | Dark | Light |
|---|---|---|
| `--bg` | #141414 | #f5f3f0 |
| `--surface` | #1a1a1a | #ffffff |
| `--surface-2` | #1f1f1f | #f0eeeb |
| `--surface-3` | #282828 | #e8e5e0 |
| `--border` | rgba(255,255,255,0.10) | rgba(0,0,0,0.08) |
| `--border-hover` | rgba(255,255,255,0.16) | rgba(0,0,0,0.14) |
| `--text` | #f0ede8 | #1c1b1a |
| `--text-2` | #a8a39e | #5c5a57 |
| `--text-3` | #6e6a67 | #9c9a97 |
| `--accent` | #c9a97a | #b8935f |
| `--accent-dim` | rgba(201,169,122,0.12) | rgba(184,147,95,0.12) |
| `--accent-fg` | #0d0d0d | #ffffff |
| `--danger` | #d96b6b | #d96b6b |
| `--danger-dim` | rgba(217,107,107,0.1) | rgba(217,107,107,0.08) |
| `--success` | #5aaa80 | #5aaa80 |

### Files Modified
- `static/css/style.css` — add `[data-theme="light"]` block
- `static/index.html` — add theme dropdown + inline script
- `static/image.html` — add theme dropdown + inline script
- `static/admin.html` — add theme dropdown + inline script
