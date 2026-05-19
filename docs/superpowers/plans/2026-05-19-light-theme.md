# Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a light color theme with a dropdown in the header to switch between dark and light.

**Architecture:** Use `data-theme` attribute on `<html>` to toggle CSS custom property sets. Store preference in localStorage. Add `<select>` dropdown in `.user-info` header area on all 3 authenticated pages.

**Tech Stack:** CSS custom properties, vanilla JS, localStorage

---

### Task 1: Add light theme CSS variables

**Files:**
- Modify: `static/css/style.css` — add `[data-theme="light"]` block after `:root`

- [ ] **Step 1: Add `[data-theme="light"]` CSS block**

After the `:root` block (ends at line 42), add:

```css
html[data-theme="light"] {
  --bg: #f5f3f0;
  --surface: #ffffff;
  --surface-2: #f0eeeb;
  --surface-3: #e8e5e0;
  --border: rgba(0, 0, 0, 0.08);
  --border-hover: rgba(0, 0, 0, 0.14);
  --text: #1c1b1a;
  --text-2: #5c5a57;
  --text-3: #9c9a97;
  --accent: #b8935f;
  --accent-dim: rgba(184, 147, 95, 0.12);
  --accent-fg: #ffffff;
  --danger-dim: rgba(217, 107, 107, 0.08);
}
```

- [ ] **Step 2: Set default `data-theme="dark"` on `<html>` in style.css**

At the top of `style.css`, add before `:root`:
```css
html {
  color-scheme: dark;
}
html[data-theme="light"] {
  color-scheme: light;
}
```

---

### Task 2: Add theme dropdown to all authenticated pages

**Files:**
- Modify: `static/index.html`
- Modify: `static/image.html`
- Modify: `static/admin.html`

Each page needs:
1. A `<select>` element with "Dark" / "Light" options in `.user-info`
2. An inline script that reads `theme` from localStorage, applies it, and handles changes
3. The script must run synchronously before page render to avoid flash

- [ ] **Step 1: Add theme dropdown + script to index.html**

In `.user-info` div, after `<span id="username"></span>` and before `</div>`, add:
```html
<select id="themeSelect" class="theme-select">
  <option value="dark">Dark</option>
  <option value="light">Light</option>
</select>
```

At the bottom of the page (in the existing inline `<script>` block), add theme logic:
```javascript
(function() {
  var saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  var sel = document.getElementById('themeSelect');
  if (sel) {
    sel.value = saved || 'dark';
    sel.addEventListener('change', function() {
      document.documentElement.dataset.theme = sel.value;
      localStorage.setItem('theme', sel.value);
    });
  }
})();
```

Also add the `<select>` to the top of the page before render, since it needs to exist when the script runs.

- [ ] **Step 2: Same changes in image.html**

Same as step 1, applied to `static/image.html`.

- [ ] **Step 3: Same changes in admin.html**

Same as step 1, applied to `static/admin.html`.

- [ ] **Step 4: Verify**

Restart server, check all 3 pages:
- Theme dropdown appears next to username
- Selecting "Light" switches to light theme immediately
- Refreshing the page preserves the selection
- Selecting "Dark" switches back
- No flash of wrong theme on page load
